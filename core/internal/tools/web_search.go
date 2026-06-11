package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// WebSearchTool performs web searches using a search API
type WebSearchTool struct{}

type webSearchArgs struct {
	Query      string `json:"query"`
	MaxResults int    `json:"max_results,omitempty"`
}

type webSearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

// Execute performs a web search
func (t *WebSearchTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var payload webSearchArgs
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if payload.Query == "" {
		return "", fmt.Errorf("query is required")
	}

	maxResults := payload.MaxResults
	if maxResults <= 0 || maxResults > 10 {
		maxResults = 5
	}

	// Try multiple search backends in order
	results, err := searchDuckDuckGo(ctx, payload.Query, maxResults)
	if err != nil {
		// Fallback: try Google Custom Search if configured
		results, err = searchGoogleCSE(ctx, payload.Query, maxResults)
		if err != nil {
			return "", fmt.Errorf("web search failed: %w", err)
		}
	}

	if len(results) == 0 {
		return "No results found for: " + payload.Query, nil
	}

	// Format results
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("### Web Search Results for: %q\n\n", payload.Query))
	for i, r := range results {
		sb.WriteString(fmt.Sprintf("%d. **[%s](%s)**\n", i+1, r.Title, r.URL))
		if r.Snippet != "" {
			sb.WriteString(fmt.Sprintf("   %s\n\n", r.Snippet))
		}
	}

	return sb.String(), nil
}

// searchDuckDuckGo uses DuckDuckGo's HTML search interface
func searchDuckDuckGo(ctx context.Context, query string, maxResults int) ([]webSearchResult, error) {
	apiURL := "https://html.duckduckgo.com/html/?q=" + url.QueryEscape(query)

	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequestWithContext(ctx, "POST", apiURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8")
    req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
    bodyText := string(bodyBytes)

	var results []webSearchResult

    // Simple regex to extract organic results
    snippetRe := regexp.MustCompile(`(?s)<a class="result__snippet[^>]*>(.*?)</a>`)
	urlRe := regexp.MustCompile(`(?s)<a class="result__url[^>]*href="([^"]+)"`)
	titleRe := regexp.MustCompile(`(?s)<h2 class="result__title">.*?<a[^>]*>(.*?)</a>`)

	snippets := snippetRe.FindAllStringSubmatch(bodyText, -1)
	urls := urlRe.FindAllStringSubmatch(bodyText, -1)
	titles := titleRe.FindAllStringSubmatch(bodyText, -1)

    cleanHTML := func(s string) string {
        s = strings.ReplaceAll(s, "<b>", "")
        s = strings.ReplaceAll(s, "</b>", "")
        return strings.TrimSpace(s)
    }

	for i := 0; i < len(snippets) && i < len(urls) && i < len(titles) && len(results) < maxResults; i++ {
        href := urls[i][1]
        // Decode DDG redirect URL if present
        if strings.HasPrefix(href, "//duckduckgo.com/l/?uddg=") {
            href = strings.TrimPrefix(href, "//duckduckgo.com/l/?uddg=")
            if idx := strings.Index(href, "&"); idx != -1 {
                href = href[:idx]
            }
            if decoded, err := url.QueryUnescape(href); err == nil {
                href = decoded
            }
        } else if strings.HasPrefix(href, "/url?q=") { // Just in case Google CSE structure is ever matched
             href = strings.TrimPrefix(href, "/url?q=")
             if idx := strings.Index(href, "&"); idx != -1 {
                href = href[:idx]
            }
            if decoded, err := url.QueryUnescape(href); err == nil {
                href = decoded
            }
        }

        // Ensure valid http prefix
        if !strings.HasPrefix(href, "http") {
            continue
        }

        results = append(results, webSearchResult{
            URL: href,
            Title: cleanHTML(titles[i][1]),
            Snippet: cleanHTML(snippets[i][1]),
        })
	}

	return results, nil
}

// searchGoogleCSE uses Google Custom Search Engine (requires API key)
func searchGoogleCSE(_ context.Context, _ string, _ int) ([]webSearchResult, error) {
	// This is a placeholder — requires GOOGLE_CSE_KEY and GOOGLE_CSE_CX env vars
	// For now, return an error that signals "not configured"
	return nil, fmt.Errorf("Google CSE not configured")
}
