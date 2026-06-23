package grikauth

import (
	"testing"

	"github.com/igoryan-dao/ricochet/internal/config"
)

func TestAPIURLNormalizesBase(t *testing.T) {
	client := Client{APIBaseURL: "https://example.test"}
	if got, want := client.apiURL("/auth/device/code"), "https://example.test/api/v1/auth/device/code"; got != want {
		t.Fatalf("apiURL mismatch: got %q want %q", got, want)
	}

	client = Client{APIBaseURL: "https://example.test/api/v1/"}
	if got, want := client.apiURL("/users/me"), "https://example.test/api/v1/users/me"; got != want {
		t.Fatalf("apiURL mismatch: got %q want %q", got, want)
	}
}

func TestAccessTokenPrecedence(t *testing.T) {
	settings := config.Settings{}
	settings.Provider.APIKeys = map[string]string{"grik": "provider-token"}
	settings.Auth.GrikAccessToken = "auth-token"

	token, source := AccessToken(settings)
	if token != "auth-token" || source != "settings.auth" {
		t.Fatalf("unexpected token/source: %q %q", token, source)
	}

	settings.Auth.GrikAccessToken = ""
	token, source = AccessToken(settings)
	if token != "provider-token" || source != "provider.api_keys.grik" {
		t.Fatalf("unexpected token/source: %q %q", token, source)
	}
}
