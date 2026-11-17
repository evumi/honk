// Package widget checks and cleans the HTML card a bot sends with a message.
//
// The format follows Telegram's HTML widgets (Bot API 10.4): one small HTML
// document, at most 32 KB raw and 4 KB after zlib at level 9. This is profile
// v1: static HTML and CSS only. Scripts and inline event handlers are removed;
// the client fills {{key}} placeholders from the message's data. The client
// applies its own CSS whitelist when it renders, so the server only removes
// what could reach the network or run code.
package widget

import (
	"bytes"
	"compress/zlib"
	"errors"
	"regexp"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// Limits, the same as Telegram's.
const (
	MaxRaw        = 32 * 1024
	MaxCompressed = 4 * 1024
	MaxData       = 1024
)

// Errors returned by Clean. Their text is the error code sent to the bot.
var (
	ErrTooLarge = errors.New("WIDGET_TOO_LARGE")
	ErrInvalid  = errors.New("WIDGET_HTML_INVALID")
)

// allowed lists the elements kept, with their children. Anything else is
// dropped with its whole subtree.
var allowed = map[string]bool{}

func init() {
	for _, t := range strings.Fields(`
		div span p br hr h1 h2 h3 h4 h5 h6 section article header footer main aside nav
		pre code blockquote figure figcaption strong b em i u s small sub sup mark abbr time
		ul ol li dl dt dd table caption thead tbody tfoot tr th td colgroup col details summary
		img a button style
		svg g path rect circle ellipse line polyline polygon text tspan defs lineargradient radialgradient stop symbol use title desc`) {
		allowed[t] = true
	}
}

// Wrapper elements the parser adds or authors may send; their children are
// kept but the element itself is not.
var unwrap = map[string]bool{"html": true, "head": true, "body": true}

var (
	dataImage   = regexp.MustCompile(`^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$`)
	placeholder = regexp.MustCompile(`^\{\{\s*[A-Za-z0-9_.]+\s*\}\}$`)
	// @import and expression() reach the network or run code from CSS; so does
	// url() unless it holds an inline data: image.
	cssImport = regexp.MustCompile(`(?i)@import|expression\s*\(|\\`)
	cssURL    = regexp.MustCompile(`(?i)url\s*\(\s*['"]?\s*([^'")\s]*)`)
)

// Clean checks the size limits and returns the cleaned HTML. An empty input
// returns "".
func Clean(src string) (string, error) {
	if src == "" {
		return "", nil
	}
	if len(src) > MaxRaw {
		return "", ErrTooLarge
	}
	if strings.ContainsRune(src, 0) {
		return "", ErrInvalid
	}
	ctx := &html.Node{Type: html.ElementNode, Data: "body", DataAtom: atom.Body}
	nodes, err := html.ParseFragment(strings.NewReader(src), ctx)
	if err != nil {
		return "", ErrInvalid
	}
	var out bytes.Buffer
	for _, n := range nodes {
		for _, kept := range clean(n) {
			if err := html.Render(&out, kept); err != nil {
				return "", ErrInvalid
			}
		}
	}
	res := out.String()
	if len(res) > MaxRaw {
		return "", ErrTooLarge
	}
	if n, err := compressedSize(res); err != nil || n > MaxCompressed {
		return "", ErrTooLarge
	}
	return res, nil
}

// clean returns what is left of n: n itself, its children (for an unwrapped
// wrapper) or nothing.
func clean(n *html.Node) []*html.Node {
	switch n.Type {
	case html.TextNode:
		return []*html.Node{n}
	case html.ElementNode:
	default: // comments, doctypes
		return nil
	}
	name := strings.ToLower(n.Data)
	if unwrap[name] {
		return cleanChildren(n)
	}
	if !allowed[name] {
		return nil
	}
	if name == "style" {
		if n.FirstChild != nil && badCSSText(n.FirstChild.Data) {
			return nil
		}
		return []*html.Node{n}
	}
	attrs := n.Attr[:0]
	for _, a := range n.Attr {
		if keepAttr(name, a) {
			attrs = append(attrs, a)
		}
	}
	n.Attr = attrs
	kids := cleanChildren(n)
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		n.RemoveChild(c)
		c = next
	}
	for _, k := range kids {
		if k.Parent != nil {
			k.Parent.RemoveChild(k)
		}
		n.AppendChild(k)
	}
	return []*html.Node{n}
}

func cleanChildren(n *html.Node) []*html.Node {
	var out []*html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		out = append(out, clean(c)...)
	}
	return out
}

func keepAttr(el string, a html.Attribute) bool {
	key := strings.ToLower(a.Key)
	if a.Namespace != "" && a.Namespace != "xlink" {
		return false
	}
	if strings.HasPrefix(key, "on") {
		return false
	}
	switch key {
	case "src":
		return el == "img" && dataImage.MatchString(strings.TrimSpace(a.Val))
	case "href":
		return okHref(el, a.Val)
	case "style":
		return !badCSSText(a.Val)
	case "srcset", "formaction", "action", "contenteditable", "draggable", "tabindex", "autofocus", "accesskey":
		return false
	}
	return true
}

func okHref(el, v string) bool {
	v = strings.TrimSpace(v)
	switch el {
	case "a":
		return strings.HasPrefix(v, "https://") || strings.HasPrefix(v, "#") || placeholder.MatchString(v)
	case "use":
		return strings.HasPrefix(v, "#") // same-document symbols only
	}
	return false
}

// badCSSText reports CSS that loads anything other than an inline data: image.
func badCSSText(css string) bool {
	// A backslash escape could spell "url" or "@import" past the patterns.
	if cssImport.MatchString(css) {
		return true
	}
	for _, m := range cssURL.FindAllStringSubmatch(css, -1) {
		if !strings.HasPrefix(strings.ToLower(m[1]), "data:image/") {
			return true
		}
	}
	return false
}

func compressedSize(s string) (int, error) {
	var buf bytes.Buffer
	w, err := zlib.NewWriterLevel(&buf, zlib.BestCompression)
	if err != nil {
		return 0, err
	}
	if _, err := w.Write([]byte(s)); err != nil {
		return 0, err
	}
	if err := w.Close(); err != nil {
		return 0, err
	}
	return buf.Len(), nil
}
