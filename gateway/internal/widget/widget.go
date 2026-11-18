// Package widget checks and cleans the HTML card a bot sends with a message.
//
// The format follows Telegram's HTML widgets (Bot API 10.4): one small HTML
// document, at most 32 KB raw and 4 KB after zlib at level 9. Profile 1 is
// static HTML and CSS; the client fills {{key}} placeholders from the
// message's data. Profile 2 adds inline scripts, which the apps run in a
// QuickJS runtime per card (native/card) with no network; older apps skip
// them and show the static card. Inline event handlers (on*), external and
// module scripts and every other way to load a resource are removed. The
// client applies its own CSS whitelist when it renders, so the server only
// removes what could reach the network. <style> blocks stay as they are when
// they load nothing; the app applies their rules (up to 400, as Telegram does).
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

// svgElements are the allowed SVG elements, whose attributes are CSS values
// too (fill, stroke, mask, clip-path, filter, marker-*).
var svgElements = map[string]bool{}

func init() {
	for _, t := range strings.Fields(`svg g path rect circle ellipse line polyline polygon text tspan defs lineargradient radialgradient stop symbol use title desc`) {
		svgElements[t] = true
	}
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
	// Functions besides url() that take an image or resource as a string:
	// image-set("https://…" 1x) would fetch without any url().
	cssLoaders = regexp.MustCompile(`(?i)(?:^|[^\w-])(?:-webkit-)?(?:image-set|cross-fade|image|element|src)\s*\(`)
	cssURL     = regexp.MustCompile(`(?i)url\s*\(\s*['"]?\s*([^'")\s]*)`)
	// A script tag inside script text, as the HTML tokenizer sees one (the
	// name followed by space, / or >), or a comment opener.
	ambiguousScript = regexp.MustCompile(`(?i)<!--|</?script[\s/>]`)
)

// Report is what Inspect found: the cleaned HTML, its sizes and what the
// whitelist removed.
type Report struct {
	HTML       string   `json:"html"`
	InputSize  int      `json:"input_size"`      // bytes sent
	Raw        int      `json:"raw_size"`        // bytes of HTML after cleaning
	Compressed int      `json:"compressed_size"` // zlib level 9, after cleaning
	Removed    []string `json:"removed"`         // e.g. "<iframe>", "onclick on <div>"
}

// remove records one removal, once per distinct description.
func (rp *Report) remove(what string) {
	if rp == nil {
		return
	}
	for _, r := range rp.Removed {
		if r == what {
			return
		}
	}
	rp.Removed = append(rp.Removed, what)
}

// Clean checks the size limits and returns the cleaned HTML. An empty input
// returns "".
func Clean(src string) (string, error) {
	rp, err := Inspect(src)
	return rp.HTML, err
}

// Inspect is Clean with a report. On a size error the report still carries
// the sizes found (the cleaned HTML is empty).
func Inspect(src string) (Report, error) {
	rp := Report{InputSize: len(src), Removed: []string{}}
	if src == "" {
		return rp, nil
	}
	if len(src) > MaxRaw {
		return rp, ErrTooLarge
	}
	if strings.ContainsRune(src, 0) {
		return rp, ErrInvalid
	}
	ctx := &html.Node{Type: html.ElementNode, Data: "body", DataAtom: atom.Body}
	nodes, err := html.ParseFragment(strings.NewReader(src), ctx)
	if err != nil {
		return rp, ErrInvalid
	}
	var out bytes.Buffer
	for _, n := range nodes {
		for _, kept := range clean(n, &rp) {
			if err := html.Render(&out, kept); err != nil {
				return rp, ErrInvalid
			}
		}
	}
	res := out.String()
	rp.Raw = len(res)
	if len(res) > MaxRaw {
		return rp, ErrTooLarge
	}
	n, err := compressedSize(res)
	rp.Compressed = n
	if err != nil || n > MaxCompressed {
		return rp, ErrTooLarge
	}
	rp.HTML = res
	return rp, nil
}

// clean returns what is left of n: n itself, its children (for an unwrapped
// wrapper) or nothing.
func clean(n *html.Node, rp *Report) []*html.Node {
	switch n.Type {
	case html.TextNode:
		return []*html.Node{n}
	case html.ElementNode:
	default: // comments, doctypes
		return nil
	}
	name := strings.ToLower(n.Data)
	if unwrap[name] {
		return cleanChildren(n, rp)
	}
	if name == "script" {
		if !keepScript(n) {
			rp.remove("<script> (external, module or ambiguous)")
			return nil
		}
		n.Attr = nil
		return []*html.Node{n}
	}
	if !allowed[name] {
		rp.remove("<" + name + ">")
		return nil
	}
	if name == "style" {
		if n.FirstChild != nil && badCSSText(n.FirstChild.Data) {
			rp.remove("<style> (loads a resource)")
			return nil
		}
		return []*html.Node{n}
	}
	attrs := n.Attr[:0]
	for _, a := range n.Attr {
		if keepAttr(name, a) {
			attrs = append(attrs, a)
		} else {
			rp.remove(strings.ToLower(a.Key) + " on <" + name + ">")
		}
	}
	n.Attr = attrs
	kids := cleanChildren(n, rp)
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

// keepScript reports an inline classic script in HTML (not SVG): no src, and
// no type other than JavaScript. Modules are dropped: a card cannot import.
func keepScript(n *html.Node) bool {
	if n.Namespace != "" {
		return false
	}
	for _, a := range n.Attr {
		switch strings.ToLower(a.Key) {
		case "src":
			return false
		case "type":
			switch strings.ToLower(strings.TrimSpace(a.Val)) {
			case "", "text/javascript", "application/javascript":
			default:
				return false
			}
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.TextNode {
			return false
		}
		// Script text with "<!--", "<script" or "</script" parses differently
		// here (the HTML spec's escaped states) and in the app's simpler
		// parser, which would read what follows as markup the whitelist never saw.
		if ambiguousScript.MatchString(c.Data) {
			return false
		}
	}
	return true
}

func cleanChildren(n *html.Node, rp *Report) []*html.Node {
	var out []*html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		out = append(out, clean(c, rp)...)
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
	if svgElements[el] && badSVGValue(a.Val) {
		return false
	}
	return true
}

// badSVGValue reports an SVG attribute value that could load something: a
// url() other than a same-document reference (url(#grad)), or a CSS escape
// that could spell one.
func badSVGValue(v string) bool {
	if strings.Contains(v, `\`) {
		return true
	}
	for _, m := range cssURL.FindAllStringSubmatch(v, -1) {
		if !strings.HasPrefix(m[1], "#") {
			return true
		}
	}
	return false
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
	if cssImport.MatchString(css) || cssLoaders.MatchString(css) {
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
