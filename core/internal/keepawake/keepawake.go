package keepawake

import (
	"fmt"
	"os/exec"
	"runtime"
)

type Guard struct {
	cmd *exec.Cmd
}

func Start(reason string) (*Guard, error) {
	switch runtime.GOOS {
	case "darwin":
		cmd := exec.Command("caffeinate", "-dimsu")
		if err := cmd.Start(); err != nil {
			return &Guard{}, fmt.Errorf("start caffeinate for %s: %w", reason, err)
		}
		return &Guard{cmd: cmd}, nil
	default:
		return &Guard{}, nil
	}
}

func (g *Guard) Stop() {
	if g == nil || g.cmd == nil || g.cmd.Process == nil {
		return
	}
	_ = g.cmd.Process.Kill()
	_, _ = g.cmd.Process.Wait()
	g.cmd = nil
}
