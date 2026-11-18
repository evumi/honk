package api

import (
	"regexp"
	"strings"
)

// The Markdown subset of parse_mode=Markdown: **bold** (or __bold__),
// *italic* (or _italic_), `code`, fenced code blocks, [text](url) links and
// "-", "*", "+" or "1." lists. The app renders it; StripMarkdown makes the
// plain text of the banner.
var (
	mdCode   = regexp.MustCompile("`[^`\n]+`")
	mdLink   = regexp.MustCompile(`\[([^\]\n]+)\]\(([^)\s]+)\)`)
	mdBold   = regexp.MustCompile(`\*\*(.+?)\*\*|__(.+?)__`)
	mdItalic = regexp.MustCompile(`\*([^*\s][^*]*?)\*|(^|[^\p{L}\p{N}_])_([^_\s][^_]*?)_($|[^\p{L}\p{N}_])`)
	mdList   = regexp.MustCompile(`^(\s*)[-*+]\s+`)
	mdHead   = regexp.MustCompile(`^#{1,6}\s+`)
)

// StripMarkdown returns text with the Markdown marks removed.
func StripMarkdown(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	var out []string
	fenced := false
	for _, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "```") {
			fenced = !fenced
			continue
		}
		if fenced {
			out = append(out, l)
			continue
		}
		l = mdHead.ReplaceAllString(l, "")
		l = mdList.ReplaceAllString(l, "${1}• ")
		out = append(out, stripInline(l))
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// stripInline removes the marks of one line, leaving code spans' text as is.
func stripInline(l string) string {
	var b strings.Builder
	last := 0
	for _, loc := range mdCode.FindAllStringIndex(l, -1) {
		b.WriteString(stripMarks(l[last:loc[0]]))
		b.WriteString(l[loc[0]+1 : loc[1]-1])
		last = loc[1]
	}
	b.WriteString(stripMarks(l[last:]))
	return b.String()
}

func stripMarks(s string) string {
	// Only https links are links in the app (markup.ts); anything else stays as
	// written there, so the banner keeps it as written too.
	s = mdLink.ReplaceAllStringFunc(s, func(m string) string {
		p := mdLink.FindStringSubmatch(m)
		if !strings.HasPrefix(strings.ToLower(p[2]), "https://") {
			return m
		}
		return p[1]
	})
	s = mdBold.ReplaceAllString(s, "$1$2")
	// Twice: a match consumes its neighbours, so "_a_ _b_" needs a second pass.
	for i := 0; i < 2; i++ {
		s = mdItalic.ReplaceAllString(s, "$1$2$3$4")
	}
	return s
}
