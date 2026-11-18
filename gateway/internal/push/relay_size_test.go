package push

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fixedMeta map[string]string

func (m fixedMeta) GetMeta(_ context.Context, k string) (string, error) { return m[k], nil }
func (m fixedMeta) SetMeta(_ context.Context, k, v string) error        { m[k] = v; return nil }

// The worst request the client builds must fit the relay's body cap: text full
// of "<>&" (not escaped) or of control characters (six bytes each).
func TestRelayRequestWorstCaseFitsCap(t *testing.T) {
	for name, ch := range map[string]string{"html": "<>&", "control": "\x01"} {
		var got []byte
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got, _ = io.ReadAll(r.Body)
			_, _ = w.Write([]byte(`{"ok":true,"result":true}`))
		}))
		meta := fixedMeta{"relay_url": srv.URL, "relay_id": "r1", "relay_key": "k"}
		rl := NewRelay(srv.URL, meta, "test", nil)
		rl.Bare = false
		fill := func(n int) string { return strings.Repeat(ch, n)[:n] }
		err := rl.Push(context.Background(), Notification{
			Platform: "android", Token: fill(1024), Kind: "message", MessageID: 1<<62 - 1, TargetID: 1<<62 - 1,
			BotID: "Kx3abcde", BotName: fill(2000), Title: fill(5000), Body: fill(5000), Group: fill(2000),
			Level: "timeSensitive", CollapseID: fill(500),
		})
		srv.Close()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(got) > MaxRelayRequest {
			t.Errorf("%s: request is %d bytes, cap %d", name, len(got), MaxRelayRequest)
		}
		if name == "html" && bytes.Contains(got, []byte("\\u00"+"3c")) {
			t.Error("html characters are escaped")
		}
		t.Logf("%s: %d bytes", name, len(got))
	}
	if RelayClientTimeout <= RelayServerTimeout {
		t.Error("client must wait longer than the relay")
	}
}
