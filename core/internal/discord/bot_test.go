package discord

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/igoryan-dao/ricochet/internal/state"
)

func TestDiscordBotTokenIDDoesNotExposeToken(t *testing.T) {
	token := "discord-token-secret"
	id := discordBotTokenID(token)
	if id == "" {
		t.Fatal("expected token id")
	}
	if strings.Contains(id, token) || strings.Contains(token, id) {
		t.Fatalf("token id exposes token: %q", id)
	}
	if len(id) != 16 {
		t.Fatalf("expected 16 character token id, got %d: %q", len(id), id)
	}
}

func TestAcquireDiscordBotLockInHomePreventsSecondOwner(t *testing.T) {
	home := t.TempDir()
	token := "discord-token-secret"

	firstLock, firstPath, locked, err := acquireDiscordBotLockInHome(token, home)
	if err != nil {
		t.Fatalf("first lock returned error: %v", err)
	}
	if !locked {
		t.Fatal("expected first lock to be acquired")
	}
	defer firstLock.Unlock()

	if got, want := firstPath, filepath.Join(home, ".ricochet", "discord-bot-"+discordBotTokenID(token)+".lock"); got != want {
		t.Fatalf("unexpected lock path: got %q want %q", got, want)
	}

	secondLock, secondPath, locked, err := acquireDiscordBotLockInHome(token, home)
	if err != nil {
		t.Fatalf("second lock returned error: %v", err)
	}
	if locked {
		if secondLock != nil {
			_ = secondLock.Unlock()
		}
		t.Fatal("expected second lock acquisition to be blocked")
	}
	if secondPath != firstPath {
		t.Fatalf("second lock path mismatch: got %q want %q", secondPath, firstPath)
	}
}

func TestStartRespectsDisabledGatewayMode(t *testing.T) {
	t.Setenv("RICOCHET_DISCORD_GATEWAY_MODE", "disabled")
	b, err := NewWithConfig(Config{Token: "discord-token-secret"}, nil)
	if err != nil {
		t.Fatalf("NewWithConfig returned error: %v", err)
	}
	if err := b.Start(); err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	if b.IsRunning() {
		t.Fatal("expected disabled gateway mode to keep bot stopped")
	}
	if got := b.GatewayOwner(); got != "disabled" {
		t.Fatalf("unexpected gateway owner: %q", got)
	}
	if !strings.Contains(b.StatusError(), "disabled") {
		t.Fatalf("expected disabled status error, got %q", b.StatusError())
	}
}

func TestStartRespectsCloudGatewayMode(t *testing.T) {
	t.Setenv("RICOCHET_DISCORD_GATEWAY_MODE", "cloud")
	b, err := NewWithConfig(Config{Token: "discord-token-secret"}, nil)
	if err != nil {
		t.Fatalf("NewWithConfig returned error: %v", err)
	}
	if err := b.Start(); err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	if b.IsRunning() {
		t.Fatal("expected cloud gateway mode to keep local bot stopped")
	}
	if got := b.GatewayOwner(); got != "cloud" {
		t.Fatalf("unexpected gateway owner: %q", got)
	}
}

func TestBoundDiscordTextRoutesToControllerInbox(t *testing.T) {
	b, err := NewWithConfig(Config{Token: "discord-token-secret", TextMode: true}, nil)
	if err != nil {
		t.Fatalf("NewWithConfig returned error: %v", err)
	}
	target := state.MessengerTarget{Platform: "discord", ChannelID: "channel-1"}
	b.SetActiveSessionForTarget(target, "session-1")

	sessionCh := make(chan string, 1)
	b.RegisterSessionHandler("session-1", sessionCh)
	defer b.UnregisterSessionHandler("session-1")

	b.handleMessage(nil, &discordgo.MessageCreate{Message: &discordgo.Message{
		ID:        "1456955772943466542",
		ChannelID: "channel-1",
		Content:   "hello from bound thread",
		Author:    &discordgo.User{ID: "user-1", Username: "tester"},
	}})

	select {
	case resp := <-b.GetResponseChannel():
		if resp.Text != "hello from bound thread" {
			t.Fatalf("unexpected response text: %q", resp.Text)
		}
		if resp.SessionID != "session-1" {
			t.Fatalf("expected active session to be preserved, got %q", resp.SessionID)
		}
	case <-time.After(time.Second):
		t.Fatal("expected response to be routed to controller inbox")
	}

	select {
	case text := <-sessionCh:
		t.Fatalf("did not expect direct session delivery, got %q", text)
	default:
	}
}
