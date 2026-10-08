package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func certificate(t *testing.T) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "campus.invalid"}, DNSNames: []string{"campus.invalid"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true}
	der, e := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if e != nil {
		t.Fatal(e)
	}
	cert, e := x509.ParseCertificate(der)
	if e != nil {
		t.Fatal(e)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, cert
}
func fixture(t *testing.T, handler http.HandlerFunc) (*session, grant, *httptest.Server, *atomic.Int64) {
	t.Helper()
	cert, leaf := certificate(t)
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	connections := &atomic.Int64{}
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	sum := sha256.Sum256(leaf.Raw)
	g := grant{Available: true, Protocol: "personal-file-campus-v1", Kind: "campus-direct", RouteID: "primary", Endpoint: "https://campus.invalid:" + strings.Split(server.Listener.Addr().String(), ":")[1], Pin: hex.EncodeToString(sum[:]), Revision: strings.Repeat("c", 64), Machine: "fixture", ID: "01234567-1234-4234-8234-012345678901", Ticket: strings.Repeat("t", 32), Expires: time.Now().Unix() + 300, Chunk: chunkLimit, File: fileIdentity{Protocol: 2, Path: "source.bin"}}
	s := &session{roots: pool, routeFn: func() (route, error) {
		return route{Name: "fixture-kernel-interface", Index: 2, Gateway: "01020304", Addresses: "192.0.2.1/24"}, nil
	}, dialFn: func(ctx context.Context, _ route, _ string, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
	}}
	t.Cleanup(s.close)
	return s, g, server, connections
}
func put(g grant, seq int64, offset int64, body []byte, final bool) frame {
	return frame{Schema: 1, Seq: seq, Op: "put", Grant: g, Offset: offset, Final: &final, BodyBytes: len(body)}
}
func TestRawBytesAndKeepalive(t *testing.T) {
	var stored bytes.Buffer
	requests := 0
	s, g, _, connections := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) {
			t.Error("ticket absent")
		}
		body, e := io.ReadAll(r.Body)
		if e != nil {
			t.Error(e)
		}
		stored.Write(body)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"result":{"receivedBytes":`+strconv.Itoa(stored.Len())+`}}`)
	})
	first := bytes.Repeat([]byte{0, 255, 42, 13}, chunkLimit/4)
	last := []byte("tail\x00")
	for i, b := range [][]byte{first, last} {
		offset := int64(0)
		if i == 1 {
			offset = int64(len(first))
		}
		r, raw := s.request(put(g, int64(i+1), offset, b, i == 1), b)
		if !r.OK || len(raw) != 0 {
			t.Fatalf("unexpected reply %+v", r)
		}
	}
	if !bytes.Equal(stored.Bytes(), append(first, last...)) || requests != 2 || connections.Load() != 1 {
		t.Fatalf("bytes/reuse requests=%d connections=%d", requests, connections.Load())
	}
}
func TestDatasetUsesOriginalUUIDAndLegalSmallChunks(t *testing.T) {
	id := "12345678-1234-4234-8234-123456789012"
	content := bytes.Repeat([]byte{0, 255, 42, 13}, (2*chunkLimit)/4)
	content = append(content, []byte("tail")...)
	var stored, manifest bytes.Buffer
	requests := 0
	s, g, _, connections := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) {
			t.Error("ticket absent")
		}
		prefix := "/v1/uploads/" + id + "/"
		if !strings.HasPrefix(r.URL.Path, prefix) {
			t.Errorf("original UUID changed: %s", r.URL.Path)
		}
		action := strings.TrimPrefix(r.URL.Path, prefix)
		w.Header().Set("Content-Type", "application/json")
		if action == "status" {
			if r.Method != "GET" || r.URL.Query().Get("path") != "a file.bin" {
				t.Error("fixed status path changed")
			}
			io.WriteString(w, `{"ok":true,"result":{"file":{"offset":0}}}`)
			return
		}
		body, e := io.ReadAll(r.Body)
		if e != nil || len(body) > chunkLimit || r.Method != "POST" {
			t.Error("invalid body")
		}
		offset, e := strconv.Atoi(r.URL.Query().Get("offset"))
		if e != nil {
			t.Error(e)
		}
		if action == "manifest" {
			if offset != manifest.Len() {
				t.Error("manifest offset changed")
			}
			manifest.Write(body)
		} else {
			if action != "chunk" || r.URL.Query().Get("path") != "a file.bin" || offset != stored.Len() {
				t.Error("file identity changed")
			}
			stored.Write(body)
		}
		io.WriteString(w, `{"ok":true,"result":{"offset":`+strconv.Itoa(offset+len(body))+`}}`)
	})
	g.Protocol = "dataset-upload-v1"
	g.ID = ""
	g.MaxChunk = 16 * chunkLimit
	g.File = fileIdentity{}
	frames := []frame{{Schema: 1, Seq: 1, Op: "status", Grant: g, UploadID: id, Path: "a file.bin"}, {Schema: 1, Seq: 2, Op: "manifest", Grant: g, UploadID: id, BodyBytes: 3}}
	bodies := [][]byte{nil, []byte("{}\n")}
	for offset := 0; offset < len(content); offset += chunkLimit {
		end := offset + chunkLimit
		if end > len(content) {
			end = len(content)
		}
		body := content[offset:end]
		frames = append(frames, frame{Schema: 1, Seq: int64(len(frames) + 1), Op: "chunk", Grant: g, UploadID: id, Path: "a file.bin", Offset: int64(offset), BodyBytes: len(body)})
		bodies = append(bodies, body)
	}
	for i, f := range frames {
		out, raw := s.request(f, bodies[i])
		if !out.OK || len(raw) != 0 {
			t.Fatalf("%+v", out)
		}
	}
	if manifest.String() != "{}\n" || sha256.Sum256(stored.Bytes()) != sha256.Sum256(content) || requests != 5 || connections.Load() != 1 {
		t.Fatal("bytes, original UUID or keepalive changed")
	}
	changed := frames[len(frames)-1]
	changed.UploadID = "12345678-1234-4234-8234-123456789013"
	if out, _ := s.request(changed, bodies[len(bodies)-1]); out.Code != "GRANT_IDENTITY_CHANGED" || requests != 5 {
		t.Fatalf("cross upload escaped: %+v", out)
	}
}
func TestDatasetLostAckAndLimitsNeverReplay(t *testing.T) {
	var writes atomic.Int64
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		writes.Add(1)
		conn, _, e := w.(http.Hijacker).Hijack()
		if e != nil {
			t.Error(e)
			return
		}
		conn.Close()
	})
	g.Protocol = "dataset-upload-v1"
	g.ID = ""
	g.MaxChunk = 16 * chunkLimit
	g.File = fileIdentity{}
	f := frame{Schema: 1, Seq: 1, Op: "chunk", Grant: g, UploadID: "12345678-1234-4234-8234-123456789012", Path: "fixed.bin", BodyBytes: 3}
	out, _ := s.request(f, []byte("raw"))
	if out.OK || !out.WriteMayHaveReachedPeer || writes.Load() != 1 {
		t.Fatalf("%+v", out)
	}
	if out, _ := s.request(f, []byte("raw")); out.Code != "SESSION_STOPPED" || writes.Load() != 1 {
		t.Fatalf("replayed %+v", out)
	}
	for _, patch := range []func(*frame){func(f *frame) { f.BodyBytes = chunkLimit + 1 }, func(f *frame) { f.Grant.RouteID = "tail" }, func(f *frame) { f.Path = "../other" }, func(f *frame) { f.Op = "status" }, func(f *frame) { f.UploadID = "not-a-uuid" }} {
		bad := f
		patch(&bad)
		if validate(bad) == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
}
func TestDownloadFixedIdentityAndRawBound(t *testing.T) {
	all := bytes.Repeat([]byte{93}, chunkLimit+29)
	fingerprint := strings.Repeat("f", 64)
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		end := offset + chunkLimit
		if end > len(all) {
			end = len(all)
		}
		metadata, _ := json.Marshal(map[string]any{"protocol": 2, "path": "source.bin", "size": len(all), "offset": offset, "eof": end == len(all), "fingerprint": fingerprint})
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-GPUQ-File-Metadata", base64.RawURLEncoding.EncodeToString(metadata))
		w.Write(all[offset:end])
	})
	g.File.Size = int64(len(all))
	g.File.Fingerprint = fingerprint
	var downloaded []byte
	for i, offset := range []int64{0, chunkLimit} {
		r, b := s.request(frame{Schema: 1, Seq: int64(i + 1), Op: "get", Grant: g, Offset: offset}, nil)
		if !r.OK {
			t.Fatalf("%+v", r)
		}
		downloaded = append(downloaded, b...)
	}
	if !bytes.Equal(downloaded, all) {
		t.Fatal("raw full file mismatch")
	}
}
func TestLostAckNeverReplaysOriginalWrite(t *testing.T) {
	requests := 0
	original := []byte("persisted once")
	var stored []byte
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		stored, _ = io.ReadAll(r.Body)
		c, _, e := w.(http.Hijacker).Hijack()
		if e != nil {
			t.Fatal(e)
		}
		c.Close()
	})
	f := put(g, 1, 0, original, true)
	r, _ := s.request(f, original)
	if r.OK || !r.WriteMayHaveReachedPeer || requests != 1 || !bytes.Equal(stored, original) {
		t.Fatal("lost ACK did not preserve unknown write")
	}
	f.Seq = 2
	again, _ := s.request(f, original)
	if again.Code != "SESSION_STOPPED" || requests != 1 || f.Grant.ID != g.ID {
		t.Fatal("write replayed or identity replaced")
	}
}
func TestTLSVerifiedBeforeTicketOrBody(t *testing.T) {
	for _, which := range []string{"pin", "ca"} {
		t.Run(which, func(t *testing.T) {
			calls := 0
			s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { calls++; io.ReadAll(r.Body) })
			if which == "pin" {
				g.Pin = strings.Repeat("0", 64)
			} else {
				s.roots = x509.NewCertPool()
			}
			r, _ := s.request(put(g, 1, 0, []byte("secret"), true), []byte("secret"))
			if r.OK || calls != 0 || r.WriteMayHaveReachedPeer {
				t.Fatal("unverified peer received request")
			}
			expected := "TLS_PIN_CHANGED"
			if which == "ca" {
				expected = "TLS_UNTRUSTED"
			}
			if r.Code != expected {
				t.Fatalf("%+v", r)
			}
		})
	}
}

func TestCertificateRotationStopsBeforeNewTicket(t *testing.T) {
	calls := 0
	s, g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Connection", "close")
		io.WriteString(w, `{"ok":true,"result":{}}`)
	})
	first, _ := s.request(put(g, 1, 0, nil, false), nil)
	if !first.OK {
		t.Fatal(first.Code)
	}
	next, leaf := certificate(t)
	s.roots.AddCert(leaf)
	// httptest's TLS listener reads this config on the next handshake; the
	// existing connection explicitly closed after its confirmed response.
	server.TLS.Certificates = []tls.Certificate{next}
	result, _ := s.request(put(g, 2, 0, []byte("next body"), true), []byte("next body"))
	if result.Code != "TLS_PIN_CHANGED" || calls != 1 || result.WriteMayHaveReachedPeer {
		t.Fatal("changed certificate received bearer/body")
	}
}

func TestBindDeniedNeverEscalatesOrFallsBack(t *testing.T) {
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { t.Fatal("fallback request reached a peer") })
	attempts := 0
	s.dialFn = func(context.Context, route, string, string) (net.Conn, error) {
		attempts++
		return nil, errors.New("PHYSICAL_BIND_DENIED")
	}
	result, _ := s.request(put(g, 1, 0, nil, true), nil)
	if result.Code != "PHYSICAL_BIND_DENIED" || attempts != 1 || result.WriteMayHaveReachedPeer {
		t.Fatal("bind denial bypassed")
	}
}
func TestRouteChangeStopsBeforeNextBlock(t *testing.T) {
	calls := 0
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"result":{}}`)
	})
	first, _ := s.request(put(g, 1, 0, []byte("a"), false), []byte("a"))
	if !first.OK {
		t.Fatal(first.Code)
	}
	old, _ := s.routeFn()
	s.routeFn = func() (route, error) { old.Gateway = "FFFFFFFF"; return old, nil }
	r, _ := s.request(put(g, 2, 1, []byte("b"), true), []byte("b"))
	if r.Code != "NETWORK_CHANGED" || calls != 1 {
		t.Fatal("network change permitted a write")
	}
}
func TestChangedDescriptorAndRedirectStop(t *testing.T) {
	for _, change := range []string{"revision", "pin", "machine", "origin", "redirect"} {
		t.Run(change, func(t *testing.T) {
			calls := 0
			s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				io.ReadAll(r.Body)
				if change == "redirect" {
					http.Redirect(w, r, "https://relay.invalid", 302)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"ok":true,"result":{}}`)
			})
			r, _ := s.request(put(g, 1, 0, nil, false), nil)
			if change == "redirect" {
				if r.Code != "HTTP_REJECTED" || calls != 1 {
					t.Fatal("redirect followed")
				}
				return
			}
			if !r.OK {
				t.Fatal(r.Code)
			}
			switch change {
			case "revision":
				g.Revision = strings.Repeat("d", 64)
			case "pin":
				g.Pin = strings.Repeat("e", 64)
			case "machine":
				g.Machine = "different"
			case "origin":
				g.Endpoint = "https://other.invalid:18441"
			}
			r, _ = s.request(put(g, 2, 0, nil, true), nil)
			if r.Code != "GRANT_IDENTITY_CHANGED" || calls != 1 {
				t.Fatal("descriptor change permitted bytes")
			}
		})
	}
}
func TestBoundedResponsesAndInvalidMetadata(t *testing.T) {
	for _, kind := range []string{"body", "metadata", "headers"} {
		t.Run(kind, func(t *testing.T) {
			s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				if kind == "headers" {
					w.Header().Set("X-Large", strings.Repeat("x", headerLimit+1))
				}
				w.Header().Set("Content-Type", "application/octet-stream")
				w.Header().Set("X-GPUQ-File-Metadata", base64.RawURLEncoding.EncodeToString([]byte(`{"protocol":2,"path":"foreign","data":"private"}`)))
				if kind == "body" {
					w.Write(bytes.Repeat([]byte("x"), chunkLimit+1))
				} else {
					w.Write([]byte("x"))
				}
			})
			g.File.Size = chunkLimit + 1
			g.File.Fingerprint = strings.Repeat("f", 64)
			r, _ := s.request(frame{Schema: 1, Seq: 1, Op: "get", Grant: g}, nil)
			if r.OK {
				t.Fatal("invalid response accepted")
			}
		})
	}
}
func TestFrameBoundsNoSecretEcho(t *testing.T) {
	s := &session{routeFn: func() (route, error) { return route{}, errors.New("NO_ROUTE") }}
	var input bytes.Buffer
	binary.Write(&input, binary.BigEndian, uint32(headerLimit+1))
	var output bytes.Buffer
	if run(&input, &output, s) == nil {
		t.Fatal("unbounded frame accepted")
	}
	if bytes.Contains(output.Bytes(), []byte("ticket")) {
		t.Fatal("credential in error")
	}
	var header bytes.Buffer
	binary.Write(&header, binary.BigEndian, uint32(13))
	header.WriteString(`{"schema":1}`)
	if _, _, e := readFrame(&header); e == nil {
		t.Fatal("invalid operation accepted")
	}
}
func TestMainDefaultRoutesAreGenericAndAmbiguityRejects(t *testing.T) {
	head := "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n"
	line := func(name, metric string) string {
		return name + " 00000000 01020304 0003 0 0 " + metric + " 00000000 0 0 0\n"
	}
	r, e := defaultRoute(head + line("any-kernel-ethernet-name", "50") + line("another-nic", "100"))
	if e != nil || r.Name != "any-kernel-ethernet-name" {
		t.Fatal("default selection")
	}
	if _, e = defaultRoute(head + line("one", "50") + line("two", "50")); e == nil {
		t.Fatal("ambiguous routes selected")
	}
	if _, e = defaultRoute(head); e == nil {
		t.Fatal("no default selected")
	}
	if _, e = defaultRoute(head + "damaged\n"); e == nil {
		t.Fatal("damaged route accepted")
	}
}
