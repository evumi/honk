package hooks

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

type ghPayload struct {
	Action     string `json:"action"`
	Ref        string `json:"ref"`
	Compare    string `json:"compare"`
	Deleted    bool   `json:"deleted"`
	Forced     bool   `json:"forced"`
	Repository struct {
		FullName string `json:"full_name"`
		HTMLURL  string `json:"html_url"`
	} `json:"repository"`
	Sender struct {
		Login string `json:"login"`
	} `json:"sender"`
	Pusher struct {
		Name string `json:"name"`
	} `json:"pusher"`
	Commits    []struct{ Message string } `json:"commits"`
	HeadCommit *struct {
		Message string `json:"message"`
	} `json:"head_commit"`
	WorkflowRun *struct {
		ID         int64  `json:"id"`
		WorkflowID int64  `json:"workflow_id"`
		Name       string `json:"name"`
		Title      string `json:"display_title"`
		Status     string `json:"status"`
		Conclusion string `json:"conclusion"`
		HTMLURL    string `json:"html_url"`
		HeadBranch string `json:"head_branch"`
		RunNumber  int    `json:"run_number"`
		HeadCommit *struct {
			Message string `json:"message"`
		} `json:"head_commit"`
	} `json:"workflow_run"`
	Release *struct {
		TagName    string `json:"tag_name"`
		Name       string `json:"name"`
		HTMLURL    string `json:"html_url"`
		Body       string `json:"body"`
		Prerelease bool   `json:"prerelease"`
		Draft      bool   `json:"draft"`
	} `json:"release"`
	Issue       *ghItem `json:"issue"`
	PullRequest *ghItem `json:"pull_request"`
}

type ghItem struct {
	Number  int    `json:"number"`
	Title   string `json:"title"`
	HTMLURL string `json:"html_url"`
	Merged  bool   `json:"merged"`
	User    struct {
		Login string `json:"login"`
	} `json:"user"`
}

// GitHub converts repository webhook deliveries; the event name comes from
// the X-GitHub-Event header (or ?event=). workflow_run, release, issues,
// pull_request and push get their own layout; other events a one-line
// summary. ping is ignored. GitHub's X-Hub-Signature-256 is not checked: the
// secret in the URL (the bot token) is what authenticates the call.
func GitHub(r Request) (url.Values, error) {
	event := firstNonEmpty(r.Header.Get("X-GitHub-Event"), r.Query.Get("event"))
	if event == "" {
		return nil, fmt.Errorf("missing X-GitHub-Event header")
	}
	if event == "ping" {
		return nil, ErrIgnored
	}
	var p ghPayload
	if err := json.Unmarshal(r.Body, &p); err != nil {
		return nil, fmt.Errorf("invalid JSON body: %w", err)
	}
	repo := p.Repository.FullName
	v := url.Values{}
	set(v, "group", repo)
	set(v, "url", p.Repository.HTMLURL)

	switch {
	case event == "workflow_run" && p.WorkflowRun != nil:
		w := p.WorkflowRun
		// One message per workflow and branch: queued, in progress and
		// completed replace each other.
		v.Set("id", ghID("wf", repo, fmt.Sprint(w.WorkflowID), w.HeadBranch))
		state := firstNonEmpty(w.Conclusion, w.Status, p.Action)
		v.Set("title", trunc(fmt.Sprintf("%s: %s", w.Name, state), 250))
		body := fmt.Sprintf("%s #%d on %s", repo, w.RunNumber, w.HeadBranch)
		msg := w.Title
		if msg == "" && w.HeadCommit != nil {
			msg = w.HeadCommit.Message
		}
		if msg != "" {
			body += "\n" + firstLine(msg)
		}
		v.Set("body", body)
		switch w.Conclusion {
		case "failure", "timed_out", "startup_failure":
			v.Set("level", "timeSensitive")
		case "":
			v.Set("level", "passive") // still running
		default:
			v.Set("level", "active")
		}
		set(v, "url", w.HTMLURL)
	case event == "release" && p.Release != nil:
		rel := p.Release
		v.Set("title", trunc(fmt.Sprintf("%s %s %s", repo, firstNonEmpty(rel.Name, rel.TagName), p.Action), 250))
		v.Set("body", trunc(firstNonEmpty(rel.Body, rel.TagName), 1000))
		set(v, "url", rel.HTMLURL)
		set(v, "copy", rel.TagName)
		if rel.Prerelease || rel.Draft {
			v.Set("level", "passive")
		}
	case (event == "issues" && p.Issue != nil) || (event == "pull_request" && p.PullRequest != nil):
		it, kind := p.Issue, "issue"
		if event == "pull_request" {
			it, kind = p.PullRequest, "PR"
			if it.Merged && p.Action == "closed" {
				p.Action = "merged"
			}
		}
		v.Set("id", ghID(event, repo, fmt.Sprint(it.Number)))
		v.Set("title", trunc(fmt.Sprintf("%s %s #%d %s", repo, kind, it.Number, p.Action), 250))
		v.Set("body", trunc(fmt.Sprintf("%s (by %s)", it.Title, firstNonEmpty(it.User.Login, p.Sender.Login)), 1000))
		set(v, "url", it.HTMLURL)
		v.Set("level", "passive")
	case event == "push":
		branch := strings.TrimPrefix(p.Ref, "refs/heads/")
		switch {
		case p.Deleted:
			v.Set("title", fmt.Sprintf("%s: %s deleted", repo, branch))
		default:
			n := len(p.Commits)
			v.Set("title", trunc(fmt.Sprintf("%s: %d commit(s) to %s", repo, n, branch), 250))
		}
		body := "by " + firstNonEmpty(p.Pusher.Name, p.Sender.Login)
		if p.HeadCommit != nil {
			body += "\n" + firstLine(p.HeadCommit.Message)
		}
		v.Set("body", body)
		set(v, "url", p.Compare)
		v.Set("level", "passive")
	default:
		v.Set("title", trunc(strings.TrimSpace(fmt.Sprintf("%s %s %s", repo, event, p.Action)), 250))
		v.Set("body", fmt.Sprintf("%s event by %s", event, firstNonEmpty(p.Sender.Login, "GitHub")))
		v.Set("level", "passive")
	}
	return v, nil
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	return trunc(s, 200)
}

func ghID(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return "gh-" + parts[0] + "-" + hex.EncodeToString(sum[:8])
}
