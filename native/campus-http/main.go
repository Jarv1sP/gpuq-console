// A stdin/stdout-only, bounded HTTPS transport. No shell, proxy, route writes,
// privilege changes, bearer logging, redirects, or request replay.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const chunkLimit = 1048576
const headerLimit = 16384
const maxInteger = 9007199254740991

var hashRE = regexp.MustCompile(`^[a-f0-9]{64}$`)
var uuidRE = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var ticketRE = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

type fileIdentity struct {
	Protocol    int    `json:"protocol"`
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	Fingerprint string `json:"fingerprint"`
}
type grant struct {
	Available bool         `json:"available"`
	Protocol  string       `json:"protocol"`
	Kind      string       `json:"kind"`
	RouteID   string       `json:"routeId"`
	Endpoint  string       `json:"endpoint"`
	Pin       string       `json:"certificateSha256"`
	Revision  string       `json:"revision"`
	Machine   string       `json:"machine"`
	ID        string       `json:"grantId"`
	Ticket    string       `json:"ticket"`
	Expires   int64        `json:"expiresAt"`
	Chunk     int          `json:"chunkBytes"`
	MaxChunk  int          `json:"maxChunkBytes,omitempty"`
	File      fileIdentity `json:"file"`
}
type frame struct {
	Schema    int    `json:"schema"`
	Seq       int64  `json:"seq"`
	Op        string `json:"op"`
	Grant     grant  `json:"grant"`
	Endpoint  string `json:"endpoint,omitempty"`
	Pin       string `json:"certificateSha256,omitempty"`
	Offset    int64  `json:"offset"`
	Final     *bool  `json:"final,omitempty"`
	UploadID  string `json:"uploadId,omitempty"`
	Path      string `json:"path,omitempty"`
	BodyBytes int    `json:"bodyBytes"`
}

func writing(op string) bool { return op == "put" || op == "manifest" || op == "chunk" }
func dataset(op string) bool { return op == "status" || op == "manifest" || op == "chunk" }
func datasetPath(path string) bool {
	if path == "" || len(path) > 4096 || strings.HasPrefix(path, "/") || strings.Contains(path, "\\") {
		return false
	}
	for _, c := range path {
		if c < 32 || c == 127 {
			return false
		}
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

type reply struct {
	Schema                  int             `json:"schema"`
	Seq                     int64           `json:"seq"`
	OK                      bool            `json:"ok"`
	Code                    string          `json:"code,omitempty"`
	Status                  int             `json:"status,omitempty"`
	Result                  json.RawMessage `json:"result,omitempty"`
	Metadata                json.RawMessage `json:"metadata,omitempty"`
	BodyBytes               int             `json:"bodyBytes"`
	Interface               string          `json:"interface,omitempty"`
	RouteIdentity           string          `json:"routeIdentity,omitempty"`
	UID                     int             `json:"uid"`
	WriteMayHaveReachedPeer bool            `json:"writeMayHaveReachedPeer,omitempty"`
}
type session struct {
	routeFn func() (route, error)
	dialFn  func(context.Context, route, string, string) (net.Conn, error)
	roots   *x509.CertPool
	initial route
	fixed   string
	origin  *url.URL
	pin     string
	conn    *tls.Conn
	reader  *bufio.Reader
	stopped bool
}

func origin(value string) (*url.URL, error) {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Opaque != "" || u.String() != value {
		return nil, errors.New("INVALID_ORIGIN")
	}
	p := u.Port()
	if p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return nil, errors.New("INVALID_ORIGIN")
		}
	}
	return u, nil
}
func validate(f frame) error {
	if f.Schema != 1 || f.Seq < 1 || f.Seq > maxInteger || f.BodyBytes < 0 || f.BodyBytes > chunkLimit || f.Offset < 0 || f.Offset > maxInteger {
		return errors.New("INVALID_FRAME")
	}
	if f.Op == "probe" {
		if f.BodyBytes != 0 || f.Final != nil || !hashRE.MatchString(f.Pin) || f.Grant.Ticket != "" {
			return errors.New("INVALID_FRAME")
		}
		_, e := origin(f.Endpoint)
		return e
	}
	g := f.Grant
	now := time.Now().Unix()
	if !g.Available || g.Kind != "campus-direct" || g.RouteID != "primary" || !hashRE.MatchString(g.Pin) || !hashRE.MatchString(g.Revision) || !ticketRE.MatchString(g.Ticket) || len(g.Ticket) < 20 || len(g.Ticket) > 4096 || g.Expires <= now || g.Expires > now+301 || g.Chunk != chunkLimit || g.Machine == "" || len(g.Machine) > 256 || f.Endpoint != "" || f.Pin != "" {
		return errors.New("INVALID_GRANT")
	}
	if dataset(f.Op) {
		if g.Protocol != "dataset-upload-v1" || !uuidRE.MatchString(f.UploadID) || g.ID != "" || (g.MaxChunk != 0 && g.MaxChunk != chunkLimit && g.MaxChunk != 16*chunkLimit) || f.Final != nil || (f.Op == "manifest" && f.Path != "") || (f.Op != "manifest" && !datasetPath(f.Path)) || (f.Op == "status" && (f.BodyBytes != 0 || f.Offset != 0)) {
			return errors.New("INVALID_FRAME")
		}
		_, e := origin(g.Endpoint)
		return e
	}
	if (f.Op != "get" && f.Op != "put") || g.Protocol != "personal-file-campus-v1" || !uuidRE.MatchString(g.ID) || f.UploadID != "" || f.Path != "" || g.MaxChunk != 0 {
		return errors.New("INVALID_GRANT")
	}
	if f.Op == "put" && f.Final == nil || f.Op == "get" && (f.Final != nil || f.BodyBytes != 0 || g.File.Protocol != 2 || !hashRE.MatchString(g.File.Fingerprint) || g.File.Size < 0 || g.File.Size > maxInteger || len(g.File.Path) > 4096 || g.File.Path == "") {
		return errors.New("INVALID_FRAME")
	}
	_, e := origin(g.Endpoint)
	return e
}
func (s *session) close() {
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
		s.reader = nil
	}
}
func (s *session) network() error {
	r, e := s.routeFn()
	if e != nil {
		return e
	}
	if s.initial.Name == "" {
		s.initial = r
	} else if r.identity() != s.initial.identity() {
		return errors.New("NETWORK_CHANGED")
	}
	return nil
}
func (s *session) connect(ctx context.Context) error {
	port := s.origin.Port()
	if port == "" {
		port = "443"
	}
	raw, e := s.dialFn(ctx, s.initial, s.origin.Hostname(), port)
	if e != nil {
		return e
	}
	conn := tls.Client(raw, &tls.Config{MinVersion: tls.VersionTLS12, ServerName: s.origin.Hostname(), RootCAs: s.roots, NextProtos: []string{"http/1.1"}})
	if e = conn.HandshakeContext(ctx); e != nil {
		conn.Close()
		return errors.New("TLS_UNTRUSTED")
	}
	certs := conn.ConnectionState().PeerCertificates
	want, _ := hex.DecodeString(s.pin)
	if len(certs) == 0 {
		conn.Close()
		return errors.New("TLS_PIN_CHANGED")
	}
	actual := sha256.Sum256(certs[0].Raw)
	if subtle.ConstantTimeCompare(actual[:], want) != 1 {
		conn.Close()
		return errors.New("TLS_PIN_CHANGED")
	}
	if e = s.network(); e != nil {
		conn.Close()
		return e
	}
	s.conn = conn
	s.reader = bufio.NewReaderSize(conn, 4096)
	return nil
}
func readResponse(reader *bufio.Reader, req *http.Request) (*http.Response, error) {
	// Bound status/header bytes before net/http's parser allocates MIME fields.
	header := []byte{}
	for {
		line, e := reader.ReadSlice('\n')
		if e != nil {
			return nil, errors.New("RESPONSE_INTERRUPTED")
		}
		header = append(header, line...)
		if len(header) > headerLimit {
			return nil, errors.New("RESPONSE_INVALID")
		}
		if bytes.Equal(line, []byte("\r\n")) {
			break
		}
	}
	res, e := http.ReadResponse(bufio.NewReader(io.MultiReader(bytes.NewReader(header), reader)), req)
	if e != nil {
		return nil, errors.New("RESPONSE_INVALID")
	}
	return res, nil
}
func (s *session) request(f frame, body []byte) (out reply, raw []byte) {
	out = reply{Schema: 1, Seq: f.Seq, UID: os.Geteuid()}
	started := false
	fail := func(e error) (reply, []byte) {
		s.stopped = true
		s.close()
		out.Code = e.Error()
		out.WriteMayHaveReachedPeer = started && writing(f.Op)
		return out, nil
	}
	if s.stopped {
		return fail(errors.New("SESSION_STOPPED"))
	}
	if len(body) != f.BodyBytes {
		return fail(errors.New("INVALID_FRAME"))
	}
	if e := validate(f); e != nil {
		return fail(e)
	}
	if e := s.network(); e != nil {
		return fail(e)
	}
	endpoint, pin, fixed := f.Endpoint, f.Pin, "probe"
	if f.Op != "probe" {
		g := f.Grant
		endpoint, pin = g.Endpoint, g.Pin
		fixed = g.Revision + "\x00" + g.Machine + "\x00" + f.Op + "\x00" + g.File.Path + "\x00" + g.File.Fingerprint + "\x00" + strconv.FormatInt(g.File.Size, 10)
		if dataset(f.Op) {
			fixed = g.Revision + "\x00" + g.Machine + "\x00dataset-upload-v1\x00" + f.UploadID
		}
	}
	identity := endpoint + "\x00" + pin + "\x00" + fixed
	if s.fixed == "" {
		s.fixed = identity
		s.origin, _ = origin(endpoint)
		s.pin = pin
	} else if identity != s.fixed {
		return fail(errors.New("GRANT_IDENTITY_CHANGED"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if s.conn == nil {
		if e := s.connect(ctx); e != nil {
			return fail(e)
		}
	}
	if e := validate(f); e != nil {
		return fail(e)
	}
	deadline, _ := ctx.Deadline()
	s.conn.SetDeadline(deadline)
	target := *s.origin
	target.Path = "/capabilities"
	method := "GET"
	if f.Op != "probe" {
		target.Path = "/v1/files/" + f.Grant.ID + "/" + f.Op
		q := url.Values{}
		if f.Op != "status" {
			q.Set("offset", strconv.FormatInt(f.Offset, 10))
		}
		if dataset(f.Op) {
			target.Path = "/v1/uploads/" + f.UploadID + "/" + f.Op
			if f.Path != "" {
				q.Set("path", f.Path)
			}
		}
		if writing(f.Op) {
			method = "POST"
		}
		if f.Op == "put" {
			q.Set("final", strconv.FormatBool(*f.Final))
		}
		target.RawQuery = q.Encode()
	}
	req, e := http.NewRequestWithContext(ctx, method, target.String(), bytes.NewReader(body))
	if e != nil {
		return fail(errors.New("INVALID_FRAME"))
	}
	req.Header.Set("Accept", "application/json")
	if f.Op == "get" {
		req.Header.Set("Accept", "application/octet-stream")
	}
	// Only a verified TLS socket reaches this point, before bearer or raw bytes.
	if f.Op != "probe" {
		req.Header.Set("Authorization", "Bearer "+f.Grant.Ticket)
	}
	if writing(f.Op) {
		req.Header.Set("Content-Type", "application/octet-stream")
		req.ContentLength = int64(len(body))
	}
	started = true
	// Request.Write/ReadResponse make exactly ONE attempt, including empty final
	// writes on a reused socket. net/http.Transport's implicit retries are absent.
	if e = req.Write(s.conn); e != nil {
		return fail(errors.New("ACK_UNCONFIRMED"))
	}
	res, e := readResponse(s.reader, req)
	if e != nil {
		return fail(e)
	}
	defer res.Body.Close()
	out.Status = res.StatusCode
	limit := int64(chunkLimit)
	if f.Op != "get" {
		limit = 65536
	}
	if f.Op == "probe" {
		limit = 4096
	}
	if res.ContentLength > limit {
		return fail(errors.New("RESPONSE_INVALID"))
	}
	payload, e := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if e != nil {
		return fail(errors.New("RESPONSE_INTERRUPTED"))
	}
	if int64(len(payload)) > limit {
		return fail(errors.New("RESPONSE_INVALID"))
	}
	if e = s.network(); e != nil {
		return fail(e)
	}
	if res.StatusCode != 200 {
		return fail(errors.New("HTTP_REJECTED"))
	}
	if f.Op == "get" {
		encoded := res.Header.Get("X-GPUQ-File-Metadata")
		if len(encoded) > 4096 || res.Header.Get("Content-Type") != "application/octet-stream" {
			return fail(errors.New("RESPONSE_INVALID"))
		}
		metadata, e := base64.RawURLEncoding.DecodeString(encoded)
		if e != nil {
			return fail(errors.New("RESPONSE_INVALID"))
		}
		var m struct {
			Protocol    int    `json:"protocol"`
			Path        string `json:"path"`
			Size        int64  `json:"size"`
			Offset      int64  `json:"offset"`
			EOF         *bool  `json:"eof"`
			Fingerprint string `json:"fingerprint"`
		}
		decoder := json.NewDecoder(bytes.NewReader(metadata))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&m) != nil || m.EOF == nil || m.Protocol != 2 || m.Path != f.Grant.File.Path || m.Size != f.Grant.File.Size || m.Fingerprint != f.Grant.File.Fingerprint || m.Offset != f.Offset || m.Offset+int64(len(payload)) > m.Size || *m.EOF != (m.Offset+int64(len(payload)) == m.Size) {
			return fail(errors.New("RESPONSE_INVALID"))
		}
		out.Metadata = metadata
		raw = payload
		out.BodyBytes = len(raw)
	} else {
		if !strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
			return fail(errors.New("RESPONSE_INVALID"))
		}
		if f.Op == "probe" {
			if !json.Valid(payload) {
				return fail(errors.New("RESPONSE_INVALID"))
			}
			out.Result = payload
		} else {
			var r struct {
				OK     bool            `json:"ok"`
				Result json.RawMessage `json:"result"`
			}
			if json.Unmarshal(payload, &r) != nil || !r.OK || len(r.Result) == 0 || r.Result[0] != '{' {
				return fail(errors.New("RESPONSE_INVALID"))
			}
			out.Result = r.Result
		}
	}
	if res.Close {
		s.close()
	}
	out.OK = true
	out.Interface = s.initial.Name
	out.RouteIdentity = s.initial.identity()
	return out, raw
}
func readFrame(r io.Reader) (frame, []byte, error) {
	var n uint32
	if e := binary.Read(r, binary.BigEndian, &n); e != nil {
		return frame{}, nil, e
	}
	if n == 0 || n > headerLimit {
		return frame{}, nil, errors.New("INVALID_FRAME")
	}
	data := make([]byte, n)
	if _, e := io.ReadFull(r, data); e != nil {
		return frame{}, nil, e
	}
	var f frame
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&f) != nil || validate(f) != nil {
		return f, nil, errors.New("INVALID_FRAME")
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		return f, nil, errors.New("INVALID_FRAME")
	}
	body := make([]byte, f.BodyBytes)
	_, e := io.ReadFull(r, body)
	return f, body, e
}
func writeReply(w io.Writer, out reply, raw []byte) error {
	data, e := json.Marshal(out)
	if e != nil || len(data) > 65536 {
		return errors.New("INVALID_REPLY")
	}
	if e = binary.Write(w, binary.BigEndian, uint32(len(data))); e != nil {
		return e
	}
	if _, e = w.Write(data); e != nil {
		return e
	}
	_, e = w.Write(raw)
	return e
}
func run(r io.Reader, w io.Writer, s *session) error {
	defer s.close()
	last := int64(0)
	for {
		f, body, e := readFrame(r)
		if e == io.EOF {
			return nil
		}
		if e != nil {
			writeReply(w, reply{Schema: 1, Seq: f.Seq, Code: "INVALID_FRAME", UID: os.Geteuid()}, nil)
			return e
		}
		if f.Seq <= last {
			writeReply(w, reply{Schema: 1, Seq: f.Seq, Code: "INVALID_SEQUENCE", UID: os.Geteuid()}, nil)
			return errors.New("INVALID_SEQUENCE")
		}
		last = f.Seq
		out, raw := s.request(f, body)
		if e = writeReply(w, out, raw); e != nil {
			return e
		}
	}
}
func main() {
	if len(os.Args) != 1 || os.Getuid() != os.Geteuid() {
		os.Exit(2)
	}
	if e := run(os.Stdin, os.Stdout, &session{routeFn: currentRoute, dialFn: physicalDial}); e != nil {
		os.Exit(1)
	}
}
