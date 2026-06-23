package bridge

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
	"github.com/igoryan-dao/ricochet/internal/bridge/proto"
	"google.golang.org/grpc"
)

// Server is a mockup of the Ricochet Cloud part for testing
type Server struct {
	proto.UnimplementedBridgeServiceServer
	proto.UnimplementedChatServiceServer
	proto.UnimplementedSTTServiceServer
	upgrader websocket.Upgrader
	port     int
}

func NewServer(port int) *Server {
	return &Server{
		port: port,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

func (s *Server) Start(ctx context.Context) error {
	http.HandleFunc("/ws", s.handleWebSocket)

	server := &http.Server{Addr: fmt.Sprintf(":%d", s.port)}

	log.Printf("Bridge Test Server starting on :%d...", s.port)

	go func() {
		<-ctx.Done()
		server.Close()
	}()

	return server.ListenAndServe()
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}

	rwc := NewWebSocketRWC(conn)

	// Start Yamux session
	session, err := yamux.Server(rwc, nil)
	if err != nil {
		log.Printf("Yamux server error: %v", err)
		return
	}

	// Start gRPC server over yamux session
	grpcServer := grpc.NewServer()
	proto.RegisterBridgeServiceServer(grpcServer, s)
	proto.RegisterChatServiceServer(grpcServer, s)
	proto.RegisterSTTServiceServer(grpcServer, s)

	if err := grpcServer.Serve(session); err != nil {
		log.Printf("gRPC server error: %v", err)
	}
}

// Handshake implementation
func (s *Server) Handshake(ctx context.Context, req *proto.HandshakeRequest) (*proto.HandshakeResponse, error) {
	log.Printf("Handshake request: session=%s, version=%s", req.SessionId, req.Version)
	return &proto.HandshakeResponse{
		Success: true,
		Message: "Welcome to Ricochet Cloud Bridge",
	}, nil
}

// SendMessage implementation
func (s *Server) SendMessage(ctx context.Context, msg *proto.OutgoingMessage) (*proto.MessageResponse, error) {
	log.Printf("Server received message for chat %d: %s", msg.ChatId, msg.Body)
	return &proto.MessageResponse{
		MessageId: "cloud-msg-123",
		Success:   true,
	}, nil
}

func (s *Server) SendOutbound(ctx context.Context, msg *proto.OutboundMessage) (*proto.MessageResponse, error) {
	if msg.GetEnvelope() != nil {
		log.Printf("Server received v2 message for chat %d: %s", msg.GetEnvelope().GetChatId(), msg.GetText())
	}
	return &proto.MessageResponse{
		MessageId: "cloud-msg-123",
		Success:   true,
	}, nil
}

func (s *Server) AckEvent(ctx context.Context, ack *proto.DeliveryAck) (*proto.MessageResponse, error) {
	log.Printf("Server received ack for event %s: %s", ack.GetEventId(), ack.GetStatus())
	return &proto.MessageResponse{
		MessageId: ack.GetEventId(),
		Success:   true,
	}, nil
}

// StreamEvents implementation
func (s *Server) StreamEvents(empty *proto.Empty, stream proto.ChatService_StreamEventsServer) error {
	log.Println("New events stream established")
	// For now just keep it open
	<-stream.Context().Done()
	return nil
}

// Transcribe implementation
func (s *Server) Transcribe(stream proto.STTService_TranscribeServer) error {
	log.Println("New transcription stream established")
	var totalBytes int
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			return stream.SendAndClose(&proto.TranscriptionResponse{
				Text:    fmt.Sprintf("Mock transcription from cloud (%d bytes received)", totalBytes),
				Success: true,
			})
		}
		if err != nil {
			return err
		}
		totalBytes += len(chunk.Data)
		log.Printf("Received audio chunk: %d bytes", len(chunk.Data))
	}
}
