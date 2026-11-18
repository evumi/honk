package hooks

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"net/url"
	"strings"
)

// alertPayload covers Alertmanager's webhook (version 4) and Grafana's
// webhook contact point, which uses the same shape plus title, state, message
// and per-alert fingerprint/URLs.
type alertPayload struct {
	Version           string            `json:"version"`
	GroupKey          string            `json:"groupKey"`
	TruncatedAlerts   int               `json:"truncatedAlerts"`
	Status            string            `json:"status"`
	Receiver          string            `json:"receiver"`
	GroupLabels       map[string]string `json:"groupLabels"`
	CommonLabels      map[string]string `json:"commonLabels"`
	CommonAnnotations map[string]string `json:"commonAnnotations"`
	ExternalURL       string            `json:"externalURL"`
	Alerts            []alert           `json:"alerts"`
	// Grafana only.
	Title   string `json:"title"`
	State   string `json:"state"` // alerting or ok
	Message string `json:"message"`
}

type alert struct {
	Status       string            `json:"status"`
	Labels       map[string]string `json:"labels"`
	Annotations  map[string]string `json:"annotations"`
	StartsAt     string            `json:"startsAt"`
	EndsAt       string            `json:"endsAt"`
	GeneratorURL string            `json:"generatorURL"`
	Fingerprint  string            `json:"fingerprint"`
	SilenceURL   string            `json:"silenceURL"`
	DashboardURL string            `json:"dashboardURL"`
	PanelURL     string            `json:"panelURL"`
}

func (a alert) firing() bool { return strings.EqualFold(a.Status, "firing") }

func (a alert) name() string {
	return firstNonEmpty(a.Labels["alertname"], a.Annotations["summary"], "alert")
}

func (a alert) line() string {
	s := firstNonEmpty(a.Annotations["summary"], a.Annotations["description"], a.Annotations["message"], a.name())
	if inst := a.Labels["instance"]; inst != "" && !strings.Contains(s, inst) {
		s += " (" + inst + ")"
	}
	return s
}

// Alertmanager converts Alertmanager's webhook_config payload. The group key
// is the message id, so the "resolved" notification replaces the "firing" one.
func Alertmanager(r Request) (url.Values, error) {
	return alerts(r, "am-")
}

// Grafana converts Grafana's webhook contact point payload. A group with one
// alert uses that alert's fingerprint as id, otherwise the group key.
func Grafana(r Request) (url.Values, error) {
	return alerts(r, "gf-")
}

func alerts(r Request, prefix string) (url.Values, error) {
	var p alertPayload
	if err := json.Unmarshal(r.Body, &p); err != nil {
		return nil, fmt.Errorf("invalid JSON body: %w", err)
	}
	if len(p.Alerts) == 0 {
		return nil, ErrIgnored
	}
	firing := 0
	critical := false
	for _, a := range p.Alerts {
		if a.firing() {
			firing++
			if sev := firstNonEmpty(a.Labels["severity"], p.CommonLabels["severity"]); sev == "critical" || sev == "page" {
				critical = true
			}
		}
	}
	resolved := firing == 0
	if p.Status != "" {
		resolved = strings.EqualFold(p.Status, "resolved") && firing == 0
	}
	name := firstNonEmpty(p.GroupLabels["alertname"], p.CommonLabels["alertname"], p.Alerts[0].name())

	var title string
	switch {
	case p.Title != "": // Grafana's own title is "[FIRING:1] name ..."
		title = p.Title
	case resolved:
		title = "[RESOLVED] " + name
	default:
		title = fmt.Sprintf("[FIRING:%d] %s", firing, name)
	}

	var lines []string
	if p.Message != "" {
		lines = append(lines, p.Message)
	} else if s := firstNonEmpty(p.CommonAnnotations["summary"], p.CommonAnnotations["description"]); s != "" {
		lines = append(lines, s)
	}
	var items []string
	for i, a := range p.Alerts {
		if i == 5 {
			items = append(items, fmt.Sprintf("… and %d more", len(p.Alerts)-5+p.TruncatedAlerts))
			break
		}
		items = append(items, a.line())
	}
	if len(lines) == 0 || len(p.Alerts) > 1 {
		for _, it := range items {
			lines = append(lines, "• "+it)
		}
	}

	v := url.Values{}
	v.Set("title", trunc(title, 250))
	v.Set("body", trunc(strings.Join(lines, "\n"), 1000))
	switch {
	case resolved:
		v.Set("level", "passive")
	case critical:
		v.Set("level", "timeSensitive")
	default:
		v.Set("level", "active")
	}
	set(v, "group", firstNonEmpty(p.Receiver, name))
	link := firstNonEmpty(p.Alerts[0].PanelURL, p.Alerts[0].DashboardURL, p.Alerts[0].GeneratorURL, p.ExternalURL)
	if strings.HasPrefix(link, "http") {
		v.Set("url", link)
	}
	if id := alertID(prefix, p); id != "" {
		v.Set("id", id)
	}
	v.Set("html", StatusCard(resolved, firing, title, items, link))
	return v, nil
}

func alertID(prefix string, p alertPayload) string {
	if prefix == "gf-" && len(p.Alerts) == 1 && p.Alerts[0].Fingerprint != "" {
		return trunc(prefix+p.Alerts[0].Fingerprint, 128)
	}
	if p.GroupKey == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(p.GroupKey))
	return prefix + hex.EncodeToString(sum[:12])
}

// StatusCard is the small built-in card for an alert group: a coloured
// status pill, the title and up to five alert lines. Text is escaped, so a
// label cannot inject markup. It stays far below the card size limits.
func StatusCard(resolved bool, firing int, title string, items []string, link string) string {
	color, label := "#d92d20", fmt.Sprintf("FIRING %d", firing)
	if resolved {
		color, label = "#12b76a", "RESOLVED"
	}
	var b strings.Builder
	fmt.Fprintf(&b, `<div style="padding:12px"><span style="display:inline-block;padding:2px 10px;border-radius:999px;background:%s;color:#fff;font-size:12px;font-weight:600">%s</span>`, color, label)
	fmt.Fprintf(&b, `<h3 style="margin:8px 0 4px">%s</h3>`, html.EscapeString(trunc(title, 120)))
	if len(items) > 0 {
		b.WriteString(`<ul style="margin:0;padding-left:18px">`)
		for _, it := range items {
			fmt.Fprintf(&b, `<li>%s</li>`, html.EscapeString(trunc(it, 160)))
		}
		b.WriteString(`</ul>`)
	}
	if strings.HasPrefix(link, "https://") {
		fmt.Fprintf(&b, `<p style="margin:8px 0 0"><a href="%s">Open</a></p>`, html.EscapeString(link))
	}
	b.WriteString(`</div>`)
	return b.String()
}
