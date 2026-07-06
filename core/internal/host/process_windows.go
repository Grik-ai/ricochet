//go:build windows

package host

import (
	"os"
	"os/exec"
)

func configureCommandProcess(cmd *exec.Cmd) {}

func terminateCommandProcess(pid int, force bool) {
	if pid <= 0 {
		return
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = process.Kill()
}
