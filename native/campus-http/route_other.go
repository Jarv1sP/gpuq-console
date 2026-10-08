//go:build !linux

package main

import (
	"context"
	"errors"
	"net"
)

func currentRoute() (route, error) { return route{}, errors.New("PLATFORM_UNSUPPORTED") }
func physicalDial(context.Context, route, string, string) (net.Conn, error) {
	return nil, errors.New("PLATFORM_UNSUPPORTED")
}
