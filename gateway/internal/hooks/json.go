package hooks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// jsonFields are the bot API parameters the json hook can fill.
var jsonFields = []string{"title", "body", "url", "copy", "icon", "group", "id", "level", "image", "dry_run", "ttl"}

// JSON maps any JSON body onto message fields with the query string. A value
// starting with $ is a path into the body ($.alert.name, $.items[0].title,
// $.items.0.title); any other value is used as it is, so ?group=ci works too.
// Without a body mapping the message body is the JSON itself.
func JSON(r Request) (url.Values, error) {
	dec := json.NewDecoder(bytes.NewReader(r.Body))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("invalid JSON body: %w", err)
	}
	v := url.Values{}
	for _, f := range jsonFields {
		q := r.Query.Get(f)
		if q == "" {
			continue
		}
		if strings.HasPrefix(q, "$") {
			set(v, f, Lookup(doc, q))
		} else {
			set(v, f, q)
		}
	}
	if v.Get("body") == "" && r.Query.Get("body") == "" {
		var compact bytes.Buffer
		if json.Compact(&compact, r.Body) == nil {
			v.Set("body", trunc(compact.String(), 4000))
		}
	}
	return v, nil
}

// Lookup evaluates a simple path: $ followed by .name, [index] or .index
// steps. It returns "" when the path is missing; strings are returned as they
// are, numbers and booleans as text, objects and arrays as compact JSON.
func Lookup(doc any, path string) string {
	if !strings.HasPrefix(path, "$") {
		return ""
	}
	cur := doc
	rest := path[1:]
	for rest != "" {
		switch rest[0] {
		case '.':
			rest = rest[1:]
			end := strings.IndexAny(rest, ".[")
			if end < 0 {
				end = len(rest)
			}
			key := rest[:end]
			rest = rest[end:]
			switch c := cur.(type) {
			case map[string]any:
				var ok bool
				if cur, ok = c[key]; !ok {
					return ""
				}
			case []any:
				i, err := strconv.Atoi(key)
				if err != nil || i < 0 || i >= len(c) {
					return ""
				}
				cur = c[i]
			default:
				return ""
			}
		case '[':
			end := strings.IndexByte(rest, ']')
			if end < 0 {
				return ""
			}
			i, err := strconv.Atoi(rest[1:end])
			c, ok := cur.([]any)
			if err != nil || !ok || i < 0 || i >= len(c) {
				return ""
			}
			cur = c[i]
			rest = rest[end+1:]
		default:
			return ""
		}
	}
	switch c := cur.(type) {
	case nil:
		return ""
	case string:
		return c
	case json.Number:
		return c.String()
	case bool:
		return strconv.FormatBool(c)
	}
	b, _ := json.Marshal(cur)
	return string(b)
}
