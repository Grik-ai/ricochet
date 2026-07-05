package server

import (
	"context"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/livemode"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestSetLiveModeCreatesLazyControllerWithCallbacks(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("RICOCHET_DISCORD_GATEWAY_MODE", "disabled")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := &Handler{
		GlobalCtx: ctx,
		LiveModeConfig: &livemode.Config{
			DiscordToken: "discord-token-secret",
		},
	}
	writer := &captureWriter{}
	h.SetLiveModeEventWriter(writer)

	h.HandleMessage(protocol.RPCMessage{
		ID:      1,
		Type:    "set_live_mode",
		Payload: protocol.EncodeRPC(map[string]bool{"enabled": true}),
	}, writer)

	if h.LiveMode == nil {
		t.Fatal("LiveMode was not created")
	}
	if got := countMessagesOfType(writer.messages, "live_mode_status"); got < 2 {
		t.Fatalf("live_mode_status messages = %d, want callback plus response", got)
	}
	status := h.LiveMode.GetStatus()
	if !status.Enabled {
		t.Fatal("LiveMode status enabled = false, want true")
	}
	if discord := status.Channels["discord"]; !discord.Configured {
		t.Fatalf("discord channel = %#v, want configured", discord)
	}
}

func TestRecreateLiveModePreservesCallbacksEnabledAndDaemonState(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("RICOCHET_DISCORD_GATEWAY_MODE", "disabled")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := &Handler{
		GlobalCtx: ctx,
		LiveModeConfig: &livemode.Config{
			DiscordToken: "old-discord-token",
		},
	}
	writer := &captureWriter{}
	h.SetLiveModeEventWriter(writer)
	h.SetLiveModeDaemon(true)

	h.InitMu.Lock()
	if err := h.ensureLiveModeLocked(); err != nil {
		h.InitMu.Unlock()
		t.Fatalf("ensureLiveModeLocked: %v", err)
	}
	if _, err := h.LiveMode.Enable(ctx); err != nil {
		h.InitMu.Unlock()
		t.Fatalf("Enable: %v", err)
	}
	oldController := h.LiveMode
	h.LiveModeConfig.DiscordToken = "new-discord-token"
	if err := h.recreateLiveModeLocked(true); err != nil {
		h.InitMu.Unlock()
		t.Fatalf("recreateLiveModeLocked: %v", err)
	}
	h.InitMu.Unlock()

	if h.LiveMode == nil {
		t.Fatal("LiveMode was not recreated")
	}
	if h.LiveMode == oldController {
		t.Fatal("LiveMode controller was reused after token change")
	}
	status := h.LiveMode.GetStatus()
	if !status.Enabled {
		t.Fatal("recreated LiveMode enabled = false, want true")
	}
	if !status.IsDaemon {
		t.Fatal("recreated LiveMode IsDaemon = false, want true")
	}
	if got := countMessagesOfType(writer.messages, "live_mode_status"); got == 0 {
		t.Fatal("expected recreated LiveMode to keep status callbacks wired")
	}
}

func countMessagesOfType(messages []protocol.RPCMessage, messageType string) int {
	count := 0
	for _, msg := range messages {
		if msg.Type == messageType {
			count++
		}
	}
	return count
}
