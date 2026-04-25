//go:build !windows

package singleinstance

import "net"

var ln net.Listener

func Acquire() bool {
	l, err := net.Listen("tcp", "127.0.0.1:17843")
	if err != nil {
		return false
	}
	ln = l
	return true
}

func Release() {
	if ln != nil {
		ln.Close()
	}
}
