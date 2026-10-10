//go:build !linux && !windows

package main

import (
	"context"
	"errors"
	"net"
)

func controlDial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("PLATFORM_UNSUPPORTED")
}
