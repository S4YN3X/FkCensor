package cdp

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// Tab представляет вкладку/окно в Electron-приложении (CDP target).
type Tab struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	URL              string `json:"url"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	Type             string `json:"type"`
}

// Client — CDP-клиент для одной вкладки.
type Client struct {
	conn    *websocket.Conn
	msgID   int
	pending map[int]chan json.RawMessage
}

type cdpMessage struct {
	ID     int             `json:"id"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// ListTabs запрашивает список вкладок у CDP-сервера по указанному порту.
func ListTabs(port int) ([]Tab, error) {
	url := fmt.Sprintf("http://localhost:%d/json", port)
	resp, err := http.Get(url)
	if err != nil {
		return nil, fmt.Errorf("CDP list tabs: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var tabs []Tab
	if err := json.Unmarshal(body, &tabs); err != nil {
		return nil, fmt.Errorf("CDP parse tabs: %w", err)
	}
	return tabs, nil
}

// FindYMTab ищет вкладку с Яндекс Музыкой среди доступных таргетов.
// YM — это page-тип с URL music.yandex.* или заголовком, содержащим "Яндекс Музыка".
func FindYMTab(tabs []Tab) *Tab {
	for i := range tabs {
		t := &tabs[i]
		if t.Type != "page" {
			continue
		}
		if strings.Contains(t.URL, "music.yandex") ||
			strings.Contains(t.Title, "Яндекс Музыка") ||
			strings.Contains(t.Title, "Yandex Music") {
			return t
		}
	}
	// Fallback: первый page-тип (у Electron обычно одна страница)
	for i := range tabs {
		if tabs[i].Type == "page" {
			return &tabs[i]
		}
	}
	return nil
}

// Connect подключается к конкретной вкладке по WebSocket URL.
func Connect(wsURL string) (*Client, error) {
	dialer := websocket.DefaultDialer
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("CDP websocket connect: %w", err)
	}

	c := &Client{
		conn:    conn,
		msgID:   1,
		pending: make(map[int]chan json.RawMessage),
	}

	go c.readLoop()
	return c, nil
}

func (c *Client) readLoop() {
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		var msg cdpMessage
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		if ch, ok := c.pending[msg.ID]; ok {
			if msg.Error != nil {
				// Отправляем nil чтобы вызвавший увидел ошибку через отдельный механизм
				ch <- nil
			} else {
				ch <- msg.Result
			}
			delete(c.pending, msg.ID)
		}
	}
}

// call отправляет CDP-команду и ждёт ответа.
func (c *Client) call(method string, params interface{}) (json.RawMessage, error) {
	id := c.msgID
	c.msgID++

	ch := make(chan json.RawMessage, 1)
	c.pending[id] = ch

	msg := map[string]interface{}{
		"id":     id,
		"method": method,
		"params": params,
	}
	data, _ := json.Marshal(msg)
	if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		return nil, fmt.Errorf("CDP write: %w", err)
	}

	select {
	case result := <-ch:
		return result, nil
	case <-time.After(10 * time.Second):
		return nil, fmt.Errorf("CDP call %s timeout", method)
	}
}

// Evaluate выполняет JS-скрипт в контексте вкладки.
func (c *Client) Evaluate(script string) error {
	_, err := c.call("Runtime.evaluate", map[string]interface{}{
		"expression":            script,
		"awaitPromise":          false,
		"returnByValue":         false,
		"allowUnsafeEvalBlockedByCSP": true,
	})
	return err
}

// Close закрывает WebSocket-соединение.
func (c *Client) Close() {
	c.conn.Close()
}

// WaitForTabs ожидает появления хотя бы одной вкладки в CDP (с ретраями).
func WaitForTabs(port int, maxRetries int, delay time.Duration) ([]Tab, error) {
	for i := 0; i < maxRetries; i++ {
		tabs, err := ListTabs(port)
		if err == nil && len(tabs) > 0 {
			return tabs, nil
		}
		fmt.Printf("[cdp] Waiting for YM CDP... attempt %d/%d\n", i+1, maxRetries)
		time.Sleep(delay)
	}
	return nil, fmt.Errorf("CDP not available after %d attempts on port %d", maxRetries, port)
}
