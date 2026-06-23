package grikauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/config"
)

const (
	DefaultAPIBaseURL = "https://grik.io/api/v1"
	DefaultWebBaseURL = "https://grik.io"
)

var ErrPending = errors.New("device login pending")

type Client struct {
	APIBaseURL string
	WebBaseURL string
	HTTPClient *http.Client
}

type DeviceCode struct {
	DeviceCode      string
	UserCode        string
	VerificationURL string
	IntervalSeconds int
	ExpiresAt       time.Time
}

type Tokens struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
}

type AccountStatus struct {
	Authenticated bool                   `json:"authenticated"`
	User          map[string]interface{} `json:"user,omitempty"`
	ExpiresAt     int64                  `json:"expiresAt,omitempty"`
	APIBaseURL    string                 `json:"apiBaseUrl"`
	WebBaseURL    string                 `json:"webBaseUrl"`
	TokenSource   string                 `json:"tokenSource,omitempty"`
}

func NewClient() Client {
	apiBaseURL := strings.TrimSpace(os.Getenv("GRIKAI_API_URL"))
	if apiBaseURL == "" {
		apiBaseURL = DefaultAPIBaseURL
	}
	webBaseURL := strings.TrimSpace(os.Getenv("GRIKAI_WEB_URL"))
	if webBaseURL == "" {
		webBaseURL = DefaultWebBaseURL
	}
	return Client{
		APIBaseURL: apiBaseURL,
		WebBaseURL: webBaseURL,
		HTTPClient: &http.Client{Timeout: 20 * time.Second},
	}
}

func (c Client) StartDeviceLogin(ctx context.Context, clientName string) (DeviceCode, error) {
	var payload struct {
		Client string `json:"client"`
		Scope  string `json:"scope"`
	}
	payload.Client = firstNonEmpty(clientName, "ricochet-cli")
	payload.Scope = "ricochet_code"

	var out map[string]interface{}
	if err := c.postJSON(ctx, "/auth/device/code", "", payload, &out); err != nil {
		return DeviceCode{}, err
	}

	deviceCode := firstMapString(out, "device_code", "deviceCode")
	userCode := firstMapString(out, "user_code", "userCode")
	verificationURL := firstMapString(out, "verification_url", "verification_uri", "verificationUrl", "verificationUri")
	interval := int(firstMapFloat(out, 5, "interval"))
	if interval < 2 {
		interval = 2
	}
	expiresIn := int(firstMapFloat(out, 900, "expires_in", "expiresIn"))
	if deviceCode == "" || userCode == "" || verificationURL == "" {
		return DeviceCode{}, fmt.Errorf("Grik API returned an incomplete device login response")
	}
	return DeviceCode{
		DeviceCode:      deviceCode,
		UserCode:        userCode,
		VerificationURL: verificationURL,
		IntervalSeconds: interval,
		ExpiresAt:       time.Now().Add(time.Duration(expiresIn) * time.Second),
	}, nil
}

func (c Client) PollDeviceToken(ctx context.Context, deviceCode string) (Tokens, error) {
	var out map[string]interface{}
	err := c.postJSON(ctx, "/auth/device/token", "", map[string]string{
		"device_code": deviceCode,
		"deviceCode":  deviceCode,
	}, &out)
	if err != nil {
		var httpErr *HTTPError
		if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusAccepted {
			return Tokens{}, ErrPending
		}
		return Tokens{}, err
	}
	if strings.EqualFold(firstMapString(out, "status"), "pending") {
		return Tokens{}, ErrPending
	}
	accessToken := firstMapString(out, "access_token", "accessToken")
	refreshToken := firstMapString(out, "refresh_token", "refreshToken")
	if accessToken == "" {
		return Tokens{}, fmt.Errorf("Grik API returned no access token")
	}
	return Tokens{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresAt:    resolveExpiresAt(out),
	}, nil
}

func (c Client) WaitForDeviceToken(ctx context.Context, code DeviceCode) (Tokens, error) {
	interval := time.Duration(code.IntervalSeconds) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	for {
		if !code.ExpiresAt.IsZero() && time.Now().After(code.ExpiresAt) {
			return Tokens{}, fmt.Errorf("device login expired")
		}
		select {
		case <-ctx.Done():
			return Tokens{}, ctx.Err()
		case <-time.After(interval):
		}
		tokens, err := c.PollDeviceToken(ctx, code.DeviceCode)
		if err == nil {
			return tokens, nil
		}
		if errors.Is(err, ErrPending) {
			continue
		}
		return Tokens{}, err
	}
}

func (c Client) GetMe(ctx context.Context, accessToken string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.getJSON(ctx, "/users/me", accessToken, &out); err != nil {
		return nil, err
	}
	if user, ok := out["user"].(map[string]interface{}); ok {
		return user, nil
	}
	return out, nil
}

func (c Client) Billing(ctx context.Context, accessToken string) (map[string]interface{}, error) {
	credits := map[string]interface{}{}
	entitlements := map[string]interface{}{}
	creditsErr := c.getJSON(ctx, "/billing/credits", accessToken, &credits)
	entitlementsErr := c.getJSON(ctx, "/billing/entitlements", accessToken, &entitlements)
	if creditsErr != nil && entitlementsErr != nil {
		return nil, creditsErr
	}
	return map[string]interface{}{
		"credits":      credits,
		"entitlements": entitlements,
	}, nil
}

func SaveTokens(store *config.Store, tokens Tokens) error {
	if store == nil {
		return fmt.Errorf("settings store unavailable")
	}
	if tokens.AccessToken == "" {
		return fmt.Errorf("access token is empty")
	}
	os.Setenv("GRIKAI_ACCESS_TOKEN", tokens.AccessToken)
	return store.Update(func(s *config.Settings) {
		s.Auth.GrikAccessToken = tokens.AccessToken
		s.Auth.GrikRefreshToken = tokens.RefreshToken
		s.Auth.GrikExpiresAt = tokens.ExpiresAt.UnixMilli()
		if s.Provider.APIKeys == nil {
			s.Provider.APIKeys = make(map[string]string)
		}
		s.Provider.APIKeys["grik"] = tokens.AccessToken
		if s.Provider.Provider == "grik" {
			s.Provider.APIKey = tokens.AccessToken
		}
	})
}

func ClearTokens(store *config.Store) error {
	os.Unsetenv("GRIKAI_ACCESS_TOKEN")
	if store == nil {
		return fmt.Errorf("settings store unavailable")
	}
	return store.Update(func(s *config.Settings) {
		s.Auth.GrikAccessToken = ""
		s.Auth.GrikRefreshToken = ""
		s.Auth.GrikExpiresAt = 0
		if s.Provider.APIKeys != nil {
			delete(s.Provider.APIKeys, "grik")
		}
		if s.Provider.Provider == "grik" {
			s.Provider.APIKey = ""
		}
	})
}

func AccessToken(settings config.Settings) (string, string) {
	if strings.TrimSpace(settings.Auth.GrikAccessToken) != "" {
		return strings.TrimSpace(settings.Auth.GrikAccessToken), "settings.auth"
	}
	if strings.TrimSpace(settings.Provider.APIKeys["grik"]) != "" {
		return strings.TrimSpace(settings.Provider.APIKeys["grik"]), "provider.api_keys.grik"
	}
	if strings.TrimSpace(os.Getenv("GRIKAI_ACCESS_TOKEN")) != "" {
		return strings.TrimSpace(os.Getenv("GRIKAI_ACCESS_TOKEN")), "env"
	}
	return "", ""
}

func Status(ctx context.Context, store *config.Store) AccountStatus {
	client := NewClient()
	status := AccountStatus{
		Authenticated: false,
		APIBaseURL:    client.APIBaseURL,
		WebBaseURL:    client.WebBaseURL,
	}
	if store == nil {
		return status
	}
	settings := store.Get()
	token, source := AccessToken(settings)
	status.TokenSource = source
	status.ExpiresAt = settings.Auth.GrikExpiresAt
	if token == "" {
		return status
	}
	status.Authenticated = true
	if user, err := client.GetMe(ctx, token); err == nil {
		status.User = user
	}
	return status
}

type HTTPError struct {
	StatusCode int
	Body       string
}

func (e *HTTPError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("Grik API returned HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("Grik API returned HTTP %d: %s", e.StatusCode, e.Body)
}

func (c Client) postJSON(ctx context.Context, path string, accessToken string, payload interface{}, out interface{}) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL(path), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	if accessToken != "" {
		req.Header.Set("authorization", "Bearer "+accessToken)
	}
	return c.do(req, out)
}

func (c Client) getJSON(ctx context.Context, path string, accessToken string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiURL(path), nil)
	if err != nil {
		return err
	}
	if accessToken != "" {
		req.Header.Set("authorization", "Bearer "+accessToken)
	}
	return c.do(req, out)
}

func (c Client) do(req *http.Request, out interface{}) error {
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach Grik API at %s: %w", req.URL.String(), err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &HTTPError{StatusCode: resp.StatusCode, Body: strings.TrimSpace(string(body))}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("failed to parse Grik API response: %w", err)
	}
	return nil
}

func (c Client) apiURL(path string) string {
	base := strings.TrimSpace(c.APIBaseURL)
	if base == "" {
		base = DefaultAPIBaseURL
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return strings.TrimRight(DefaultAPIBaseURL, "/") + "/" + strings.TrimLeft(path, "/")
	}
	pathBase := strings.TrimRight(parsed.Path, "/")
	if !strings.HasSuffix(strings.ToLower(pathBase), "/api/v1") {
		pathBase = strings.TrimRight(pathBase, "/") + "/api/v1"
	}
	parsed.Path = strings.TrimRight(pathBase, "/") + "/" + strings.TrimLeft(path, "/")
	return parsed.String()
}

func resolveExpiresAt(payload map[string]interface{}) time.Time {
	for _, key := range []string{"expires_at", "expiresAt"} {
		value, ok := payload[key]
		if !ok {
			continue
		}
		switch v := value.(type) {
		case float64:
			if v > 10000000000 {
				return time.UnixMilli(int64(v))
			}
			return time.Unix(int64(v), 0)
		case string:
			if parsed, err := time.Parse(time.RFC3339, v); err == nil {
				return parsed
			}
		}
	}
	expiresIn := firstMapFloat(payload, 3600, "expires_in", "expiresIn")
	return time.Now().Add(time.Duration(expiresIn) * time.Second)
}

func firstMapString(payload map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstMapFloat(payload map[string]interface{}, fallback float64, keys ...string) float64 {
	for _, key := range keys {
		switch value := payload[key].(type) {
		case float64:
			return value
		case int:
			return float64(value)
		case string:
			var parsed float64
			if _, err := fmt.Sscanf(value, "%f", &parsed); err == nil {
				return parsed
			}
		}
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
