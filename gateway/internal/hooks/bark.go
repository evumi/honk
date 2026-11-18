package hooks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// Bark accepts what a Bark client sends when its server address is
// https://<gateway>/bot<token>/hook/bark:
//
//	GET  /<key>/<body>
//	GET  /<key>/<title>/<body>
//	GET  /<key>/<title>/<subtitle>/<body>
//	POST /push   (JSON or form: title, subtitle, body, level, group, url,
//	              copy, icon, id, device_key, ...)
//
// <key> is Bark's device key; it is ignored here, since the bot token in the
// URL already says where the message goes. Parameters can also be in the
// query string. level maps active/timeSensitive/passive as they are (Bark's
// critical becomes timeSensitive); sound, badge, call, isArchive and the
// like have no equivalent and are dropped.
func Bark(r Request) (url.Values, error) {
	in := url.Values{}
	for k, vs := range r.Query {
		in[k] = vs
	}
	if t := bytes.TrimSpace(r.Body); len(t) > 0 {
		if t[0] == '{' {
			var m map[string]any
			dec := json.NewDecoder(bytes.NewReader(t))
			dec.UseNumber()
			if err := dec.Decode(&m); err != nil {
				return nil, fmt.Errorf("invalid JSON body: %w", err)
			}
			for k, val := range m {
				if s := scalar(val); s != "" {
					in.Set(k, s)
				}
			}
		} else if f, err := url.ParseQuery(string(t)); err == nil {
			for k, vs := range f {
				in[k] = vs
			}
		}
	}
	// Path form. A single segment is the key (or "push"); the rest are
	// title, subtitle and body in Bark's order.
	if n := len(r.Rest); n >= 2 {
		segs := r.Rest[1:]
		in.Set("body", segs[len(segs)-1])
		switch len(segs) {
		case 1:
		case 2:
			in.Set("title", segs[0])
		case 3:
			in.Set("title", segs[0])
			in.Set("subtitle", segs[1])
		default:
			return nil, fmt.Errorf("too many path segments: use /<key>/<title>/<subtitle>/<body>")
		}
	}

	v := url.Values{}
	title := strings.TrimSpace(in.Get("title"))
	if sub := strings.TrimSpace(in.Get("subtitle")); sub != "" {
		if title != "" {
			title += " · " + sub
		} else {
			title = sub
		}
	}
	set(v, "title", trunc(title, 250))
	body := firstNonEmpty(in.Get("body"), in.Get("content"), in.Get("message"))
	v.Set("body", trunc(body, 4000))
	switch lv := strings.ToLower(in.Get("level")); lv {
	case "active", "passive":
		v.Set("level", lv)
	case "timesensitive", "time-sensitive", "critical":
		v.Set("level", "timeSensitive")
	}
	for _, k := range []string{"group", "url", "copy", "icon", "id", "dry_run"} {
		set(v, k, in.Get(k))
	}
	if body == "" && title == "" {
		return nil, ErrIgnored
	}
	return v, nil
}

func scalar(v any) string {
	switch c := v.(type) {
	case string:
		return c
	case json.Number:
		return c.String()
	case bool:
		return fmt.Sprint(c)
	}
	return ""
}
