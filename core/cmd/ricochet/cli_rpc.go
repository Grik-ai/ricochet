package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

type rpcClient struct {
	conn      *websocket.Conn
	messages  chan protocol.RPCMessage
	done      chan struct{}
	writeMu   sync.Mutex
	counterMu sync.Mutex
	counter   int
}

func dialRPC(ctx context.Context, addr string) (*rpcClient, error) {
	u := url.URL{Scheme: "ws", Host: addr, Path: "/ws"}
	dialer := *websocket.DefaultDialer
	if deadline, ok := ctx.Deadline(); ok {
		dialer.HandshakeTimeout = time.Until(deadline)
	}
	conn, _, err := dialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		return nil, err
	}
	c := &rpcClient{
		conn:     conn,
		messages: make(chan protocol.RPCMessage, 256),
		done:     make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

func (c *rpcClient) close() {
	close(c.done)
	_ = c.conn.Close()
}

func (c *rpcClient) nextID() string {
	c.counterMu.Lock()
	defer c.counterMu.Unlock()
	c.counter++
	return fmt.Sprintf("cli-%d", c.counter)
}

func (c *rpcClient) send(id string, method string, payload interface{}) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteJSON(protocol.RPCMessage{
		ID:      id,
		Type:    method,
		Payload: protocol.EncodeRPC(payload),
	})
}

func (c *rpcClient) request(ctx context.Context, method string, payload interface{}) (protocol.RPCMessage, error) {
	id := c.nextID()
	if err := c.send(id, method, payload); err != nil {
		return protocol.RPCMessage{}, err
	}
	for {
		select {
		case <-ctx.Done():
			return protocol.RPCMessage{}, ctx.Err()
		case msg, ok := <-c.messages:
			if !ok {
				return protocol.RPCMessage{}, fmt.Errorf("daemon connection closed")
			}
			if rpcIDEqual(msg.ID, id) {
				if msg.Error != "" {
					return msg, errors.New(msg.Error)
				}
				return msg, nil
			}
		}
	}
}

func (c *rpcClient) readLoop() {
	defer close(c.messages)
	for {
		var msg protocol.RPCMessage
		if err := c.conn.ReadJSON(&msg); err != nil {
			return
		}
		select {
		case c.messages <- msg:
		case <-c.done:
			return
		}
	}
}

func rpcIDEqual(id interface{}, expected string) bool {
	switch v := id.(type) {
	case string:
		return v == expected
	case fmt.Stringer:
		return v.String() == expected
	default:
		return fmt.Sprint(v) == expected
	}
}
