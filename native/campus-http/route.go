package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type route struct {
	Name, Gateway, Addresses string
	Index                    int
	Metric                   uint64
}

func (r route) identity() string {
	b := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s\x00%d\x00%s", r.Name, r.Index, r.Gateway, r.Metric, r.Addresses)))
	return hex.EncodeToString(b[:])
}
func defaultRoute(text string) (route, error) {
	var chosen route
	found := false
	ambiguous := false
	for i, line := range strings.Split(text, "\n") {
		if i == 0 || strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 11 {
			return route{}, errors.New("ROUTE_UNCONFIRMED")
		}
		if f[1] != "00000000" || f[7] != "00000000" {
			continue
		}
		flags, e := strconv.ParseUint(f[3], 16, 32)
		if e != nil {
			return route{}, errors.New("ROUTE_UNCONFIRMED")
		}
		if flags&1 == 0 || flags&0x200 != 0 {
			continue
		}
		metric, e := strconv.ParseUint(f[6], 10, 64)
		if e != nil {
			return route{}, errors.New("ROUTE_UNCONFIRMED")
		}
		if !found || metric < chosen.Metric {
			chosen = route{Name: f[0], Gateway: f[2], Metric: metric}
			found = true
			ambiguous = false
		} else if metric == chosen.Metric && (f[0] != chosen.Name || f[2] != chosen.Gateway) {
			ambiguous = true
		}
	}
	if !found || ambiguous {
		return route{}, errors.New("ROUTE_UNCONFIRMED")
	}
	return chosen, nil
}
