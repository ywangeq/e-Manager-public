// Copyright (c) 2026 Lark Technologies Pte. Ltd. (official CLI dependencies)
// SPDX-License-Identifier: MIT
// Built inside pinned github.com/larksuite/cli; no change to installed CLI.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/larksuite/cli/internal/auth"
	"github.com/larksuite/cli/internal/cmdutil"
	"github.com/larksuite/cli/internal/core"
	"github.com/larksuite/cli/internal/keychain"
)

const origin = "https://open.feishu.cn"

type request struct {
	ContractVersion string `json:"contractVersion"`
	AppID           string `json:"appId"`
	OpenID          string `json:"openId"`
	UnionID         string `json:"unionId"`
	Start           string `json:"start"`
	End             string `json:"end"`
	OperationID     string `json:"operationId,omitempty"`
	MessageRef      string `json:"messageRef,omitempty"`
	PageSize        int    `json:"pageSize,omitempty"`
	PageToken       string `json:"pageToken,omitempty"`
}
type event struct {
	EventRef    string `json:"eventRef"`
	Title       string `json:"title"`
	Start       string `json:"start"`
	End         string `json:"end"`
	CalendarURL string `json:"calendarUrl,omitempty"`
	MeetingURL  string `json:"meetingUrl,omitempty"`
}
type result struct {
	Events []event `json:"events"`
}
type deps struct {
	config func(request) (*core.CliConfig, error)
	token  func(*core.CliConfig) (string, error)
	get    func(context.Context, string, string, url.Values, any) error
}

func main() {
	// Private bounded stdin, no credential-bearing argv or raw error output.
	r := request{}
	body, err := io.ReadAll(io.LimitReader(os.Stdin, 4097))
	if err != nil || len(body) > 4096 {
		emit(nil)
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&r) != nil {
		emit(nil)
		return
	}
	var tail any
	if decoder.Decode(&tail) != io.EOF {
		emit(nil)
		return
	}
	f := cmdutil.NewDefault(cmdutil.NewIOStreams(strings.NewReader(""), io.Discard, io.Discard), cmdutil.InvocationContext{Profile: r.AppID})
	client, err := f.HttpClient()
	if err != nil {
		emit(nil)
		return
	}
	client.Timeout = 10 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("redirect_rejected") }
	d := deps{config: pinnedConfig, token: func(cfg *core.CliConfig) (string, error) {
		return auth.GetValidAccessToken(client, auth.NewUATCallOptions(cfg, io.Discard))
	}}
	d.get = func(ctx context.Context, token, path string, query url.Values, out any) error {
		req, err := http.NewRequestWithContext(ctx, "GET", origin+path+"?"+query.Encode(), nil)
		if err != nil {
			return errors.New("request_unavailable")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		response, err := client.Do(req)
		if err != nil {
			return errors.New("request_unavailable")
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return errors.New("request_rejected")
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
		if err != nil || len(body) > 1024*1024 {
			return errors.New("response_unavailable")
		}
		if json.Unmarshal(body, out) != nil {
			return errors.New("response_unavailable")
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	data, err := executeOperation(ctx, r, d)
	if err != nil {
		emit(nil)
		return
	}
	emit(data)
}

func pinnedConfig(r request) (*core.CliConfig, error) {
	raw, err := core.LoadMultiAppConfig()
	if err != nil || raw == nil {
		return nil, errors.New("configuration_unavailable")
	}
	// App ID is an explicit profile selector; absence/ambiguity never falls back.
	app := raw.CurrentAppConfig(r.AppID)
	if app == nil || app.AppId != r.AppID || (app.Brand != "" && app.Brand != core.BrandFeishu) || len(app.Users) == 0 || app.Users[0].UserOpenId != r.OpenID {
		return nil, errors.New("identity_mismatch")
	}
	cfg, err := core.ResolveConfigFromMulti(raw, keychain.Default(), r.AppID)
	if err != nil || cfg == nil || cfg.AppID != r.AppID || cfg.UserOpenId != r.OpenID || cfg.Brand != core.BrandFeishu {
		return nil, errors.New("identity_mismatch")
	}
	return cfg, nil
}

func read(ctx context.Context, r request, d deps) (*result, error) {
	if ctx.Err() != nil {
		return nil, errors.New("canceled")
	}
	if (r.ContractVersion != "group-feishu-read.v2" && r.ContractVersion != "group-feishu-read.v3") || !identifier(r.AppID) || !identifier(r.OpenID) || (r.UnionID != "" && !identifier(r.UnionID)) {
		return nil, errors.New("input_invalid")
	}
	start, err := time.Parse(time.RFC3339Nano, r.Start)
	if err != nil {
		return nil, errors.New("input_invalid")
	}
	end, err := time.Parse(time.RFC3339Nano, r.End)
	if err != nil || !end.After(start) || end.Sub(start) > 7*24*time.Hour {
		return nil, errors.New("input_invalid")
	}
	token, err := authenticatedToken(ctx, r, d)
	if err != nil {
		return nil, err
	}
	var response struct {
		Code *int `json:"code"`
		Data *struct {
			Items []struct {
				EventID string `json:"event_id"`
				AppLink string `json:"app_link"`
				Vchat   *struct {
					MeetingURL string `json:"meeting_url"`
				} `json:"vchat"`
				Summary string            `json:"summary"`
				Status  string            `json:"status"`
				Start   map[string]string `json:"start_time"`
				End     map[string]string `json:"end_time"`
			} `json:"items"`
			HasMore bool `json:"has_more"`
		} `json:"data"`
	}
	query := url.Values{"start_time": {strconv.FormatInt(start.Unix(), 10)}, "end_time": {strconv.FormatInt(end.Unix(), 10)}}
	if d.get(ctx, token, "/open-apis/calendar/v4/calendars/primary/events/instance_view", query, &response) != nil || response.Code == nil || *response.Code != 0 || response.Data == nil || response.Data.HasMore || len(response.Data.Items) > 100 {
		return nil, errors.New("agenda_unavailable")
	}
	// Official SDK InstanceViewCalendarEventRespData uses items,omitempty:
	// a successful data:{} is an empty calendar, not an incomplete response.
	output := &result{Events: []event{}}
	for _, item := range response.Data.Items {
		if item.Status == "cancelled" || item.Status == "canceled" {
			continue
		}
		begin, err := eventTime(item.Start)
		if err != nil {
			return nil, err
		}
		finish, err := eventTime(item.End)
		if err != nil {
			return nil, err
		}
		if len(begin) != len(finish) && (len(begin) == 10 || len(finish) == 10) || finish < begin {
			return nil, errors.New("event_invalid")
		}
		if !utf8.ValidString(item.Summary) || utf8.RuneCountInString(item.Summary) > 500 || strings.ContainsRune(item.Summary, 0) {
			return nil, errors.New("event_invalid")
		}
		if item.EventID == "" || len(item.EventID) > 256 || strings.ContainsAny(item.EventID, "\x00\n\r") {
			return nil, errors.New("event_invalid")
		}
		value := event{EventRef: item.EventID, Title: item.Summary, Start: begin, End: finish}
		if officialLink(item.AppLink, true) {
			value.CalendarURL = item.AppLink
		}
		if item.Vchat != nil && officialLink(item.Vchat.MeetingURL, false) {
			value.MeetingURL = item.Vchat.MeetingURL
		}
		output.Events = append(output.Events, value)
	}
	if ctx.Err() != nil {
		return nil, errors.New("canceled")
	}
	encoded, err := json.Marshal(output)
	if err != nil || len(encoded) > 32*1024 {
		return nil, errors.New("result_too_large")
	}
	return output, nil
}
func eventTime(value map[string]string) (string, error) {
	if date := value["date"]; date != "" {
		parsed, err := time.Parse("2006-01-02", date)
		if err == nil && parsed.Format("2006-01-02") == date {
			return date, nil
		}
	}
	if timestamp := value["timestamp"]; timestamp != "" {
		number, err := strconv.ParseInt(timestamp, 10, 64)
		if err == nil && number >= 0 && number < 253402300800 {
			return time.Unix(number, 0).UTC().Format(time.RFC3339Nano), nil
		}
	}
	return "", errors.New("event_invalid")
}
func identifier(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}
func emit(data any) {
	if data == nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": false, "error": "feishu_read_unavailable"})
		return
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "data": data})
}

// Unsupported external conference providers are omitted, never opened locally.
func officialLink(value string, calendar bool) bool {
	if len(value) == 0 || len(value) > 2048 || strings.ContainsAny(value, " \t\r\n\\") {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" {
		return false
	}
	host := parsed.Hostname()
	if calendar {
		return host == "applink.feishu.cn" || host == "applink.larkoffice.com" || host == "applink.larksuite.com"
	}
	return host == "vc.feishu.cn" || host == "vc.larkoffice.com" || host == "vc.larksuite.com"
}

func authenticatedToken(ctx context.Context, r request, d deps) (string, error) {
	if ctx.Err() != nil || !identifier(r.AppID) || !identifier(r.OpenID) || (r.UnionID != "" && !identifier(r.UnionID)) {
		return "", errors.New("identity_unavailable")
	}
	cfg, err := d.config(r)
	if err != nil || cfg == nil || cfg.AppID != r.AppID || cfg.UserOpenId != r.OpenID || cfg.Brand != core.BrandFeishu {
		return "", errors.New("identity_unavailable")
	}
	// The frozen config is used once. Every API below uses this SAME token;
	// no Factory.Config/LarkClient or default user lookup after this boundary.
	token, err := d.token(cfg)
	if err != nil || token == "" || ctx.Err() != nil {
		return "", errors.New("identity_unavailable")
	}
	var info struct {
		Code *int `json:"code"`
		Data *struct {
			OpenID  string `json:"open_id"`
			UnionID string `json:"union_id"`
		} `json:"data"`
	}
	if d.get(ctx, token, "/open-apis/authen/v1/user_info", url.Values{}, &info) != nil || info.Code == nil || *info.Code != 0 || info.Data == nil || info.Data.OpenID != r.OpenID || (r.UnionID != "" && info.Data.UnionID != r.UnionID) {
		return "", errors.New("identity_mismatch")
	}
	return token, nil
}

// Vendor adapter dispatch only: business selection and summarization stay in Skill/Tool Loop.
func executeOperation(ctx context.Context, r request, d deps) (any, error) {
	if r.ContractVersion == "group-feishu-read.v2" && r.OperationID == "" {
		if r.MessageRef != "" || r.PageSize != 0 || r.PageToken != "" {
			return nil, errors.New("input_invalid")
		}
		return read(ctx, r, d)
	}
	if r.ContractVersion != "group-feishu-read.v3" {
		return nil, errors.New("input_invalid")
	}
	switch r.OperationID {
	case "calendar.agenda.read":
		if r.MessageRef != "" || r.PageSize != 0 || r.PageToken != "" {
			return nil, errors.New("input_invalid")
		}
		return read(ctx, r, d)
	case "mail.messages.list", "mail.message.read":
		return readMail(ctx, r, d)
	default:
		return nil, errors.New("operation_unavailable")
	}
}
func readMail(ctx context.Context, r request, d deps) (any, error) {
	if r.Start != "" || r.End != "" {
		return nil, errors.New("input_invalid")
	}
	listing := r.OperationID == "mail.messages.list"
	if listing {
		if r.MessageRef != "" || r.PageSize < 1 || r.PageSize > 20 || len(r.PageToken) > 1024 || strings.ContainsAny(r.PageToken, "\x00\r\n") {
			return nil, errors.New("input_invalid")
		}
	} else if !messageIdentifier(r.MessageRef) || r.PageSize != 0 || r.PageToken != "" {
		return nil, errors.New("input_invalid")
	}
	token, err := authenticatedToken(ctx, r, d)
	if err != nil {
		return nil, err
	}
	endpoint := "/open-apis/mail/v1/user_mailboxes/me/messages"
	query := url.Values{}
	if listing {
		query.Set("folder_id", "INBOX")
		query.Set("page_size", strconv.Itoa(r.PageSize))
		if r.PageToken != "" {
			query.Set("page_token", r.PageToken)
		}
	} else {
		endpoint += "/" + url.PathEscape(r.MessageRef)
		query.Set("format", "plain_text_full")
	}
	var response struct {
		Code *int             `json:"code"`
		Data *json.RawMessage `json:"data"`
	}
	if d.get(ctx, token, endpoint, query, &response) != nil || response.Code == nil || *response.Code != 0 || response.Data == nil {
		return nil, errors.New("mail_unavailable")
	}
	if listing {
		var data struct {
			Items     []json.RawMessage `json:"items"`
			HasMore   bool              `json:"has_more"`
			PageToken string            `json:"page_token"`
		}
		if json.Unmarshal(*response.Data, &data) != nil || len(data.Items) > r.PageSize || len(data.PageToken) > 1024 || strings.ContainsAny(data.PageToken, "\x00\r\n") || (data.HasMore && data.PageToken == "") {
			return nil, errors.New("mail_result_invalid")
		}
		ids := []string{}
		for _, raw := range data.Items {
			var id string
			if json.Unmarshal(raw, &id) != nil {
				var item struct {
					MessageID string `json:"message_id"`
					ID        string `json:"id"`
				}
				if json.Unmarshal(raw, &item) != nil {
					return nil, errors.New("mail_result_invalid")
				}
				id = item.MessageID
				if id == "" {
					id = item.ID
				}
			}
			if !messageIdentifier(id) {
				return nil, errors.New("mail_result_invalid")
			}
			ids = append(ids, id)
		}
		return map[string]any{"messageRefs": ids, "hasMore": data.HasMore, "pageToken": data.PageToken}, nil
	}
	var data struct {
		Message *struct {
			MessageID    string `json:"message_id"`
			Subject      string `json:"subject"`
			Date         string `json:"date"`
			InternalDate string `json:"internal_date"`
			From         *struct {
				Name        string `json:"name"`
				MailAddress string `json:"mail_address"`
				Address     string `json:"address"`
			} `json:"head_from"`
			Body string `json:"body_plain_text"`
		} `json:"message"`
	}
	if json.Unmarshal(*response.Data, &data) != nil || data.Message == nil || data.Message.MessageID != r.MessageRef {
		return nil, errors.New("mail_result_invalid")
	}
	m := data.Message
	body := ""
	if m.Body != "" {
		decoded, err := base64.URLEncoding.DecodeString(m.Body)
		if err != nil {
			decoded, err = base64.RawURLEncoding.DecodeString(m.Body)
		}
		if err != nil || !utf8.Valid(decoded) {
			return nil, errors.New("mail_result_invalid")
		}
		body = string(decoded)
	}
	truncated := len(body) > 8000
	if truncated {
		body = body[:8000]
		for !utf8.ValidString(body) {
			body = body[:len(body)-1]
		}
	}
	sender := ""
	if m.From != nil {
		sender = m.From.MailAddress
		if sender == "" {
			sender = m.From.Address
		}
		if m.From.Name != "" {
			sender = m.From.Name + " <" + sender + ">"
		}
	}
	date := m.Date
	if date == "" {
		date = m.InternalDate
	}
	for _, field := range []struct {
		value string
		max   int
	}{{m.Subject, 1000}, {sender, 500}, {date, 128}} {
		if !utf8.ValidString(field.value) || len(field.value) > field.max || strings.ContainsRune(field.value, 0) {
			return nil, errors.New("mail_result_invalid")
		}
	}
	if strings.ContainsRune(body, 0) {
		return nil, errors.New("mail_result_invalid")
	}
	output := map[string]any{"messageRef": m.MessageID, "subject": m.Subject, "sender": sender, "date": date, "body": body, "bodyTruncated": truncated}
	for {
		encoded, err := json.Marshal(output)
		if err != nil {
			return nil, errors.New("mail_result_invalid")
		}
		if len(encoded) <= 32*1024 {
			return output, nil
		}
		if len(body) == 0 {
			return nil, errors.New("result_too_large")
		}
		body = body[:len(body)/2]
		for !utf8.ValidString(body) {
			body = body[:len(body)-1]
		}
		output["body"] = body
		output["bodyTruncated"] = true
	}
}
func messageIdentifier(value string) bool {
	if len(value) < 1 || len(value) > 256 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '=' || c == '.') {
			return false
		}
	}
	return true
}
