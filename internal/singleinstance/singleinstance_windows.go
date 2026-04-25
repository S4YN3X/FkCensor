package singleinstance

import "golang.org/x/sys/windows"

var mutexHandle windows.Handle

func Acquire() bool {
	name, _ := windows.UTF16PtrFromString("Global\\FkCensor_SingleInstance")
	h, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		return false
	}
	if err != nil {
		return false
	}
	mutexHandle = h
	return true
}

func Release() {
	if mutexHandle != 0 {
		windows.CloseHandle(mutexHandle)
	}
}
