package bridge

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
	"github.com/igoryan-dao/ricochet/internal/bridge/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

// Client handles connection to Ricochet Cloud with multiple multiplexed services
type Client struct {
	cloudURL  string
	sessionID string
	session   *yamux.Session
	grpcConn  *grpc.ClientConn

	bridgeClient proto.BridgeServiceClient
	chatClient   proto.ChatServiceClient
	sttClient    proto.STTServiceClient

	eventStream proto.ChatService_StreamEventsClient
	incomingCh  chan *proto.BridgeEvent
}

func NewClient(cloudURL, sessionID string) *Client {
	return &Client{
		cloudURL:   cloudURL,
		sessionID:  sessionID,
		incomingCh: make(chan *proto.BridgeEvent, 100),
	}
}

func (c *Client) Start(ctx context.Context) error {
	u, err := url.Parse(c.cloudURL)
	if err != nil {
		return err
	}

	log.Printf("Connecting to Ricochet Cloud at %s...", u.String())

	dialer := websocket.DefaultDialer
	conn, _, err := dialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		return fmt.Errorf("websocket dial: %w", err)
	}

	rwc := NewWebSocketRWC(conn)

	// Start Yamux session
	session, err := yamux.Client(rwc, nil)
	if err != nil {
		return fmt.Errorf("yamux client: %w", err)
	}
	c.session = session

	// gRPC over yamux
	c.grpcConn, err = grpc.DialContext(ctx, "",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return session.Open()
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return fmt.Errorf("grpc dial: %w", err)
	}

	// Initialize sub-clients
	c.bridgeClient = proto.NewBridgeServiceClient(c.grpcConn)
	c.chatClient = proto.NewChatServiceClient(c.grpcConn)
	c.sttClient = proto.NewSTTServiceClient(c.grpcConn)

	// Add auth secret to metadata
	secret := os.Getenv("RICOCHET_BRIDGE_SECRET")
	ctx = metadata.AppendToOutgoingContext(ctx, "x-bridge-secret", secret)
	if accessToken := os.Getenv("GRIKAI_ACCESS_TOKEN"); accessToken != "" {
		ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+accessToken)
	}

	// 1. Handshake
	resp, err := c.bridgeClient.Handshake(ctx, &proto.HandshakeRequest{
		SessionId: c.sessionID,
		Version:   "1.0.0",
		Secret:    secret,
	})
	if err != nil {
		return fmt.Errorf("handshake failed: %w", err)
	}
	if !resp.Success {
		return fmt.Errorf("handshake rejected: %s", resp.Message)
	}

	log.Printf("Cloud Bridge Handshake successful: %s", resp.Message)

	// 2. Start streaming events
	c.eventStream, err = c.chatClient.StreamEvents(ctx, &proto.Empty{})
	if err != nil {
		return fmt.Errorf("stream events failed: %w", err)
	}

	// Start listening for incoming events
	go c.listenLoop()

	return nil
}

func (c *Client) listenLoop() {
	for {
		event, err := c.eventStream.Recv()
		if err != nil {
			log.Printf("Bridge stream closed: %v", err)
			return
		}
		c.incomingCh <- event
	}
}

func (c *Client) Send(event *proto.BridgeEvent) error {
	// For backward compatibility, we still have Send, but it should ideally use SendMessage
	// If the payload is an outgoing message, we route it to chatClient
	if msg := event.GetOutgoingMessage(); msg != nil {
		_, err := c.chatClient.SendMessage(context.Background(), msg)
		return err
	}

	return fmt.Errorf("direct send of event type not implemented via ChatService yet")
}

func (c *Client) Incoming() <-chan *proto.BridgeEvent {
	return c.incomingCh
}

func (c *Client) Close() {
	if c.eventStream != nil {
		c.eventStream.CloseSend()
	}
	if c.grpcConn != nil {
		c.grpcConn.Close()
	}
	if c.session != nil {
		c.session.Close()
	}
}
