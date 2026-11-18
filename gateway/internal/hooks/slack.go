package hooks

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

type slackPayload struct {
	Text        string            `json:"text"`
	Attachments []slackAttachment `json:"attachments"`
	Blocks      []slackBlock      `json:"blocks"`
}

type slackAttachment struct {
	Fallback  string       `json:"fallback"`
	Color     string       `json:"color"`
	Pretext   string       `json:"pretext"`
	Title     string       `json:"title"`
	TitleLink string       `json:"title_link"`
	Text      string       `json:"text"`
	Fields    []slackField `json:"fields"`
}

type slackField struct {
	Title string `json:"title"`
	Value string `json:"value"`
}

type slackBlock struct {
	Type string `json:"type"`
	Text *struct {
		Text string `json:"text"`
	} `json:"text"`
}

var (
	slackLink    = regexp.MustCompile(`<([^<>|]+)\|([^<>]+)>`)
	slackBare    = regexp.MustCompile(`<((?:https?|mailto):[^<>|]+)>`)
	slackEntites = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&")
)

// slackText turns Slack mrkdwn into plain text: <url|label> becomes label,
// <url> the url, and the three escaped characters are restored.
func slackText(s string) string {
	s = slackLink.ReplaceAllString(s, "$2")
	s = slackBare.ReplaceAllString(s, "$1")
	return slackEntites.Replace(s)
}

// Slack converts an incoming-webhook payload (text, attachments, and the text
// of section blocks) so tools that can post to Slack can post to Honk.
func Slack(r Request) (url.Values, error) {
	body := r.Body
	if t := strings.TrimSpace(string(body)); !strings.HasPrefix(t, "{") { // legacy payload=<json> form
		if f, err := url.ParseQuery(t); err == nil && f.Get("payload") != "" {
			body = []byte(f.Get("payload"))
		}
	}
	var p slackPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("invalid JSON body: %w", err)
	}
	var parts []string
	add := func(s string) {
		if s = strings.TrimSpace(slackText(s)); s != "" {
			parts = append(parts, s)
		}
	}
	add(p.Text)
	var title, link string
	for _, a := range p.Attachments {
		add(a.Pretext)
		if title == "" {
			title, link = slackText(a.Title), a.TitleLink
		} else {
			add(a.Title)
		}
		add(a.Text)
		for _, f := range a.Fields {
			if f.Title != "" {
				add(f.Title + ": " + f.Value)
			} else {
				add(f.Value)
			}
		}
		if a.Text == "" && a.Title == "" && len(a.Fields) == 0 {
			add(a.Fallback)
		}
	}
	if p.Text == "" && len(p.Attachments) == 0 {
		for _, b := range p.Blocks {
			if b.Type == "section" && b.Text != nil {
				add(b.Text.Text)
			}
		}
	}
	if len(parts) == 0 && title == "" {
		return nil, ErrIgnored
	}
	v := url.Values{}
	set(v, "title", trunc(title, 250))
	v.Set("body", trunc(strings.Join(parts, "\n"), 4000))
	if strings.HasPrefix(link, "http") {
		v.Set("url", link)
	}
	return v, nil
}
