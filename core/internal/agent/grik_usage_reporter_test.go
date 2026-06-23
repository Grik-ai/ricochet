package agent

import "testing"

func TestShouldReportHostedUsage(t *testing.T) {
	if !shouldReportHostedUsage(UsageEvent{Provider: "grik", Model: "ricochet-code"}) {
		t.Fatal("expected grik provider usage to be reported")
	}
	if shouldReportHostedUsage(UsageEvent{Provider: "openrouter", KeySource: "user", Model: "openai/gpt-4o"}) {
		t.Fatal("expected BYOK usage to stay local")
	}
	if shouldReportHostedUsage(UsageEvent{Provider: "openrouter", KeySource: "server", Model: "openai/gpt-4o"}) {
		t.Fatal("expected local server-key usage to stay local")
	}
	if !shouldReportHostedUsage(UsageEvent{Provider: "openrouter", KeySource: "hosted", Model: "openai/gpt-5.5"}) {
		t.Fatal("expected hosted subscription usage to be reported")
	}
	if shouldReportHostedUsage(UsageEvent{Provider: "grik", Model: "qwen/qwen3-coder:free"}) {
		t.Fatal("expected free model usage to stay local")
	}
}
