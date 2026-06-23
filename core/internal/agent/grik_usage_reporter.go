package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

type grikUsageReportResponse struct {
	OK                  bool   `json:"ok"`
	Error               string `json:"error"`
	Decision            string `json:"decision"`
	BillingURL          string `json:"billing_url"`
	ApprovalRequired    bool   `json:"approval_required"`
	BudgetExceeded      bool   `json:"budget_exceeded"`
	InsufficientCredits bool   `json:"insufficient_credits"`
}

type grikUsageQuoteResponse struct {
	OK               bool   `json:"ok"`
	Allowed          bool   `json:"allowed"`
	Error            string `json:"error"`
	Decision         string `json:"decision"`
	Reason           string `json:"reason"`
	ReservationID    string `json:"reservation_id"`
	BillingURL       string `json:"billing_url"`
	EstimatedCredits int    `json:"estimated_credits"`
	Budget           struct {
		Allowed                  bool   `json:"allowed"`
		Product                  string `json:"product"`
		Plan                     string `json:"plan"`
		Balance                  int    `json:"balance"`
		WindowRemaining          int    `json:"window_remaining"`
		TaskRemaining            int    `json:"task_remaining"`
		PremiumApprovalRequired  bool   `json:"premium_approval_required"`
		PremiumApprovalThreshold int    `json:"premium_approval_threshold"`
		UpgradeURL               string `json:"upgrade_url"`
	} `json:"budget"`
}

func shouldReportHostedUsage(event UsageEvent) bool {
	provider := strings.ToLower(strings.TrimSpace(event.Provider))
	keySource := strings.ToLower(strings.TrimSpace(event.KeySource))
	model := strings.ToLower(strings.TrimSpace(event.Model))
	if keySource == "user" || strings.Contains(model, ":free") {
		return false
	}
	return provider == "grik" || keySource == "hosted"
}

func reportGrikHostedUsage(ctx context.Context, event UsageEvent) error {
	if !shouldReportHostedUsage(event) {
		return nil
	}
	accessToken := strings.TrimSpace(os.Getenv("GRIKAI_ACCESS_TOKEN"))
	if accessToken == "" {
		return nil
	}
	idempotencyKey := event.TurnID
	if idempotencyKey == "" {
		idempotencyKey = fmt.Sprintf("%s:%s:%s:%d", event.SessionID, event.RunID, event.Model, event.Timestamp)
	}

	payload := map[string]interface{}{
		"reservation_id":          event.ReservationID,
		"idempotency_key":         idempotencyKey,
		"session_id":              event.SessionID,
		"run_id":                  event.RunID,
		"turn_id":                 event.TurnID,
		"task_id":                 firstNonEmptyString(event.RunID, event.SessionID),
		"provider":                event.Provider,
		"model":                   event.Model,
		"key_source":              event.KeySource,
		"operation":               event.Operation,
		"source":                  event.Source,
		"input_tokens":            event.InputTokens,
		"output_tokens":           event.OutputTokens,
		"cached_input_tokens":     event.CachedInputTokens,
		"cache_creation_tokens":   event.CacheCreationTokens,
		"reasoning_output_tokens": event.ReasoningOutputTokens,
		"estimated_cost_usd":      event.EstimatedCostUSD,
		"hosted_ai":               true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, grikAPIURL("/ricochet/usage/report"), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+accessToken)
	req.Header.Set("content-type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var decoded grikUsageReportResponse
	_ = json.NewDecoder(resp.Body).Decode(&decoded)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	if decoded.Error == "" {
		decoded.Error = fmt.Sprintf("grik usage report failed with HTTP %d", resp.StatusCode)
	}
	switch {
	case decoded.ApprovalRequired || decoded.Error == "approval_required":
		return fmt.Errorf("premium model approval required before Ricochet can continue: %s", decoded.BillingURL)
	case decoded.BudgetExceeded || decoded.Error == "budget_exceeded":
		return fmt.Errorf("Ricochet Code budget exceeded; add credits or continue with BYOK: %s", decoded.BillingURL)
	case decoded.InsufficientCredits || decoded.Error == "insufficient_credits":
		return fmt.Errorf("Ricochet Code hosted AI credits are required: %s", decoded.BillingURL)
	default:
		return errors.New(decoded.Error)
	}
}

func preflightGrikHostedUsage(ctx context.Context, event UsageEvent) (string, error) {
	if !shouldReportHostedUsage(event) {
		return "", nil
	}
	accessToken := strings.TrimSpace(os.Getenv("GRIKAI_ACCESS_TOKEN"))
	if accessToken == "" {
		return "", nil
	}
	idempotencyKey := event.TurnID
	if idempotencyKey == "" {
		idempotencyKey = fmt.Sprintf("%s:%s:%s:%s", event.SessionID, event.RunID, event.Provider, event.Model)
	}
	payload := map[string]interface{}{
		"idempotency_key":         idempotencyKey,
		"session_id":              event.SessionID,
		"run_id":                  event.RunID,
		"turn_id":                 event.TurnID,
		"task_id":                 firstNonEmptyString(event.RunID, event.SessionID),
		"provider":                event.Provider,
		"model":                   event.Model,
		"key_source":              event.KeySource,
		"operation":               event.Operation,
		"source":                  "client_preflight",
		"input_tokens":            event.InputTokens,
		"max_output_tokens":       event.OutputTokens,
		"cached_input_tokens":     event.CachedInputTokens,
		"cache_creation_tokens":   event.CacheCreationTokens,
		"reasoning_output_tokens": event.ReasoningOutputTokens,
		"estimated_cost_usd":      event.EstimatedCostUSD,
		"hosted_ai":               true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, grikAPIURL("/ricochet/usage/quote"), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("authorization", "Bearer "+accessToken)
	req.Header.Set("content-type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var decoded grikUsageQuoteResponse
	_ = json.NewDecoder(resp.Body).Decode(&decoded)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && decoded.Allowed {
		return decoded.ReservationID, nil
	}
	billingURL := firstNonEmptyString(decoded.BillingURL, decoded.Budget.UpgradeURL)
	decision := firstNonEmptyString(decoded.Decision, decoded.Reason, decoded.Error)
	switch {
	case decision == "approval_required" || decoded.Budget.PremiumApprovalRequired:
		return "", fmt.Errorf("premium model approval required before Ricochet can continue: %s", billingURL)
	case decision == "insufficient_credits" || decoded.Budget.Balance <= 0:
		return "", fmt.Errorf("Ricochet Code hosted AI credits are required: %s", billingURL)
	case decision == "budget_exceeded" || resp.StatusCode >= 200 && resp.StatusCode < 300:
		return "", fmt.Errorf("Ricochet Code budget exceeded; add credits or continue with BYOK: %s", billingURL)
	default:
		return "", fmt.Errorf("grik usage quote failed with HTTP %d", resp.StatusCode)
	}
}

func grikAPIURL(path string) string {
	baseURL := strings.TrimSpace(os.Getenv("GRIKAI_API_URL"))
	if baseURL == "" {
		baseURL = "https://grik.io/api/v1"
	}
	return strings.TrimRight(baseURL, "/") + path
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func urlQueryEscape(value string) string {
	replacer := strings.NewReplacer(
		" ", "+",
		":", "%3A",
		"/", "%2F",
		"?", "%3F",
		"&", "%26",
		"=", "%3D",
		"#", "%23",
	)
	return replacer.Replace(value)
}
