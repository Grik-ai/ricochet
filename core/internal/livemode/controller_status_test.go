package livemode

import (
	"context"
	"testing"
	"time"

	"github.com/igoryan-dao/ricochet/internal/state"
)

func TestStartDoesNotOpenDiscordGateway(t *testing.T) {
	ctrl, err := New(&Config{
		DiscordToken:    "discord-token-secret",
		DiscordTextMode: false,
	}, nil)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctrl.Start(ctx)

	status := ctrl.GetStatus()

	discordStatus := status.Channels["discord"]
	if !discordStatus.Configured {
		t.Fatal("expected Discord to be configured")
	}
	if discordStatus.Active {
		t.Fatal("expected Discord to stay inactive until this process owns the gateway connection")
	}
	if status.ConnectedVia == "discord" || status.ConnectedVia == "telegram+discord" {
		t.Fatalf("unexpected connectedVia for inactive Discord gateway: %q", status.ConnectedVia)
	}
}

func TestEnableStartsDiscordGatewayAttempt(t *testing.T) {
	t.Setenv("RICOCHET_DISCORD_GATEWAY_MODE", "disabled")
	ctrl, err := New(&Config{
		DiscordToken:    "discord-token-secret",
		DiscordTextMode: false,
	}, nil)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctrl.Start(ctx)
	if _, err := ctrl.Enable(ctx); err != nil {
		t.Fatalf("Enable returned error: %v", err)
	}

	var status *Status
	for i := 0; i < 20; i++ {
		status = ctrl.GetStatus()
		if status.Channels["discord"].Owner == "disabled" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	discordStatus := status.Channels["discord"]
	if !status.Enabled {
		t.Fatal("expected Ether to be enabled")
	}
	if discordStatus.Active {
		t.Fatal("expected disabled gateway mode to keep Discord inactive")
	}
	if discordStatus.Owner != "disabled" {
		t.Fatalf("expected Discord gateway attempt to report disabled owner, got %q", discordStatus.Owner)
	}
}

func TestCanCreateRemoteSessionFollowsAllowRemoteSessionStart(t *testing.T) {
	ctrl := &Controller{}
	target := state.MessengerTarget{Platform: "discord", ChannelID: "channel-1"}
	if ctrl.canCreateRemoteSession("discord", target, "/new") {
		t.Fatal("expected remote session creation to be denied by default")
	}
	ctrl.SetAllowRemoteSessionStart(true)
	if !ctrl.canCreateRemoteSession("discord", target, "/new") {
		t.Fatal("expected remote session creation to be allowed after enabling setting")
	}
}
