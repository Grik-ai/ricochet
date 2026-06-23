package version

import (
	"os"
	"time"
)

var (
	Version   = "0.2.0-dev"
	Commit    = "dev"
	BuildTime = ""
)

type Info struct {
	Version        string `json:"version"`
	Commit         string `json:"commit"`
	BuildTime      string `json:"build_time"`
	ExecutablePath string `json:"executable_path"`
}

func Get() Info {
	executable, _ := os.Executable()
	buildTime := BuildTime
	if buildTime == "" {
		buildTime = "dev"
	}
	return Info{
		Version:        Version,
		Commit:         Commit,
		BuildTime:      buildTime,
		ExecutablePath: executable,
	}
}

func Display() string {
	if Version == "" {
		return "dev"
	}
	return Version
}

func RFC3339Now() string {
	return time.Now().UTC().Format(time.RFC3339)
}
