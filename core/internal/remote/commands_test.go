package remote

import "testing"

func TestIsSafeSlashCommand(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{name: "plain message", in: "ship it", want: true},
		{name: "safe status", in: "/status", want: true},
		{name: "safe switch", in: "/switch s_123", want: true},
		{name: "blocks local config", in: "/config set provider.api_key secret", want: false},
		{name: "blocks shell-looking command", in: "/run rm -rf .", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsSafeSlashCommand(tt.in); got != tt.want {
				t.Fatalf("IsSafeSlashCommand(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}
