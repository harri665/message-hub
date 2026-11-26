// wa-connector links to WhatsApp as a companion device (like WhatsApp Web) using whatsmeow.
//
// Incoming data (messages, history sync, receipts, contact names) is written as JSON rows into
// the shared Postgres table wa_event, which the hub consumes. Commands (send, mark read, media
// download, pairing) come from the hub over a small HTTP API guarded by INTERNAL_SECRET.
package main

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

type App struct {
	cli    *whatsmeow.Client
	db     *sql.DB
	log    waLog.Logger
	secret string

	mu      sync.Mutex
	qr      string
	pairing bool

	groupNames sync.Map // chat JID string -> struct{} once the name has been fetched
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required")
		os.Exit(1)
	}
	log := waLog.Stdout("wa", env("LOG_LEVEL", "INFO"), false)

	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Errorf("open db: %v", err)
		os.Exit(1)
	}
	if err := waitForDB(ctx, db); err != nil {
		log.Errorf("db not reachable: %v", err)
		os.Exit(1)
	}
	if err := ensureTables(ctx, db); err != nil {
		log.Errorf("create tables: %v", err)
		os.Exit(1)
	}

	container, err := sqlstore.New(ctx, "postgres", dbURL, waLog.Stdout("store", "WARN", false))
	if err != nil {
		log.Errorf("whatsmeow store: %v", err)
		os.Exit(1)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		log.Errorf("get device: %v", err)
		os.Exit(1)
	}

	// How this device shows up under "Linked devices" on the phone, and ask for as much history as allowed.
	store.DeviceProps.Os = proto.String(env("DEVICE_NAME", "Message Hub"))
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_DESKTOP.Enum()
	store.DeviceProps.RequireFullSync = proto.Bool(true)
	store.DeviceProps.HistorySyncConfig = &waCompanionReg.DeviceProps_HistorySyncConfig{
		FullSyncDaysLimit:   proto.Uint32(3650),
		FullSyncSizeMbLimit: proto.Uint32(10240),
		StorageQuotaMb:      proto.Uint32(10240),
	}

	app := &App{
		cli:    whatsmeow.NewClient(device, waLog.Stdout("client", env("LOG_LEVEL", "INFO"), false)),
		db:     db,
		log:    log,
		secret: os.Getenv("INTERNAL_SECRET"),
	}
	app.cli.AddEventHandler(app.handleEvent)

	if app.cli.Store.ID == nil {
		go app.pair()
	} else if err := app.cli.Connect(); err != nil {
		log.Errorf("connect: %v", err)
	}

	srv := &http.Server{Addr: env("LISTEN_ADDR", ":8090"), Handler: app.routes()}
	go func() {
		log.Infof("listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Errorf("http: %v", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	app.cli.Disconnect()
}

func waitForDB(ctx context.Context, db *sql.DB) error {
	var err error
	for i := 0; i < 30; i++ {
		if err = db.PingContext(ctx); err == nil {
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	return err
}

func ensureTables(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
		create table if not exists wa_event (
			id bigserial primary key,
			created_at timestamptz not null default now(),
			payload jsonb not null
		);
		create table if not exists wa_media (
			chat text not null,
			id text not null,
			message bytea not null,
			primary key (chat, id)
		);`)
	return err
}

// ---------- pairing ----------

func (a *App) pair() {
	a.mu.Lock()
	if a.pairing {
		a.mu.Unlock()
		return
	}
	a.pairing = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.pairing = false
		a.qr = ""
		a.mu.Unlock()
	}()

	a.cli.Disconnect()
	qrChan, err := a.cli.GetQRChannel(context.Background())
	if err != nil {
		a.log.Errorf("qr channel: %v", err)
		return
	}
	if err := a.cli.Connect(); err != nil {
		a.log.Errorf("connect for pairing: %v", err)
		return
	}
	for item := range qrChan {
		switch item.Event {
		case "code":
			a.mu.Lock()
			a.qr = item.Code
			a.mu.Unlock()
		case "success":
			a.log.Infof("paired successfully")
		default:
			a.log.Warnf("pairing ended: %s %v", item.Event, item.Error)
		}
	}
}

// ---------- incoming events ----------

func (a *App) handleEvent(raw any) {
	ctx := context.Background()
	switch evt := raw.(type) {
	case *events.Message:
		a.handleMessage(ctx, evt, false)
	case *events.HistorySync:
		a.handleHistory(ctx, evt)
	case *events.Receipt:
		a.handleReceipt(ctx, evt)
	case *events.PushName:
		if evt.NewPushName != "" {
			a.emit(ctx, map[string]any{"type": "contact", "address": a.address(ctx, evt.JID, evt.JIDAlt), "name": evt.NewPushName, "source": "push"})
		}
	case *events.Contact:
		if evt.Action != nil && evt.Action.GetFullName() != "" {
			a.emit(ctx, map[string]any{"type": "contact", "address": a.address(ctx, evt.JID, types.EmptyJID), "name": evt.Action.GetFullName(), "source": "contacts"})
		}
	case *events.GroupInfo:
		if evt.Name != nil {
			a.emit(ctx, map[string]any{"type": "chat", "chat": evt.JID.String(), "name": evt.Name.Name, "isGroup": true})
		}
	case *events.Connected:
		a.log.Infof("connected to WhatsApp")
		a.emit(ctx, map[string]any{"type": "status"})
	case *events.Disconnected:
		a.emit(ctx, map[string]any{"type": "status"})
	case *events.LoggedOut:
		a.log.Warnf("logged out from phone (reason %v)", evt.Reason)
		a.emit(ctx, map[string]any{"type": "status"})
	}
}

func (a *App) handleHistory(ctx context.Context, evt *events.HistorySync) {
	data := evt.Data
	for _, pn := range data.GetPushnames() {
		if pn.GetPushname() == "" {
			continue
		}
		if j, err := types.ParseJID(pn.GetID()); err == nil {
			a.emit(ctx, map[string]any{"type": "contact", "address": a.address(ctx, j, types.EmptyJID), "name": pn.GetPushname(), "source": "push"})
		}
	}
	count := 0
	for _, conv := range data.GetConversations() {
		chatJID, err := types.ParseJID(conv.GetID())
		if err != nil || chatJID.Server == types.BroadcastServer {
			continue
		}
		if chatJID.Server == types.HiddenUserServer && conv.GetPnJID() != "" {
			if pn, err := types.ParseJID(conv.GetPnJID()); err == nil {
				chatJID = pn
			}
		}
		name := conv.GetName()
		if name == "" {
			name = conv.GetDisplayName()
		}
		if chatJID.Server == types.GroupServer && name != "" {
			a.emit(ctx, map[string]any{"type": "chat", "chat": chatJID.String(), "name": name, "isGroup": true})
		}
		for _, hm := range conv.GetMessages() {
			msg, err := a.cli.ParseWebMessage(chatJID, hm.GetMessage())
			if err != nil {
				continue
			}
			a.handleMessage(ctx, msg, true)
			count++
		}
	}
	a.log.Infof("history sync %s: %d conversations, %d messages", data.GetSyncType(), len(data.GetConversations()), count)
}

func (a *App) handleReceipt(ctx context.Context, evt *events.Receipt) {
	var kind string
	switch evt.Type {
	case types.ReceiptTypeDelivered:
		kind = "delivered"
	case types.ReceiptTypeRead, types.ReceiptTypePlayed:
		kind = "read"
	case types.ReceiptTypeReadSelf:
		kind = "read-self"
	default:
		return
	}
	ids := make([]string, len(evt.MessageIDs))
	copy(ids, evt.MessageIDs)
	a.emit(ctx, map[string]any{
		"type": "receipt", "chat": a.chatID(ctx, evt.MessageSource), "ids": ids, "kind": kind,
		"timestamp": evt.Timestamp.UnixMilli(),
	})
}

func (a *App) handleMessage(ctx context.Context, evt *events.Message, historical bool) {
	info := evt.Info
	if info.Chat.Server == types.BroadcastServer || info.Chat.Server == types.NewsletterServer {
		return
	}
	m := evt.Message
	if m == nil {
		return
	}
	chat := a.chatID(ctx, info.MessageSource)
	sender := ""
	if !info.IsFromMe {
		sender = a.address(ctx, info.Sender, info.SenderAlt)
	}
	ts := info.Timestamp.UnixMilli()

	if r := m.GetReactionMessage(); r != nil {
		a.emit(ctx, map[string]any{
			"type": "reaction", "chat": chat, "target": r.GetKey().GetID(), "sender": sender,
			"fromMe": info.IsFromMe, "emoji": r.GetText(), "timestamp": ts,
		})
		return
	}
	if pm := m.GetProtocolMessage(); pm != nil {
		switch pm.GetType() {
		case waE2E.ProtocolMessage_REVOKE:
			a.emit(ctx, map[string]any{"type": "revoke", "chat": chat, "target": pm.GetKey().GetID()})
		case waE2E.ProtocolMessage_MESSAGE_EDIT:
			text, _, _ := extract(pm.GetEditedMessage())
			a.emit(ctx, map[string]any{"type": "edit", "chat": chat, "target": pm.GetKey().GetID(), "text": text, "timestamp": ts})
		}
		return
	}

	text, media, replyTo := extract(m)
	if text == "" && media == nil {
		return
	}
	if media != nil {
		if data, err := proto.Marshal(m); err == nil {
			_, _ = a.db.ExecContext(ctx,
				`insert into wa_media (chat, id, message) values ($1, $2, $3) on conflict (chat, id) do update set message = excluded.message`,
				chat, info.ID, data)
		}
	}
	isGroup := info.Chat.Server == types.GroupServer
	if isGroup && !historical {
		a.ensureGroupName(ctx, info.Chat)
	}
	payload := map[string]any{
		"type": "message", "id": info.ID, "chat": chat, "isGroup": isGroup,
		"sender": sender, "senderName": info.PushName, "fromMe": info.IsFromMe,
		"timestamp": ts, "text": text, "replyTo": replyTo, "historical": historical,
	}
	if !isGroup {
		payload["chatAddress"] = addressFromJIDString(chat)
	}
	if media != nil {
		payload["media"] = media
	}
	a.emit(ctx, payload)
}

func (a *App) ensureGroupName(ctx context.Context, jid types.JID) {
	if _, done := a.groupNames.LoadOrStore(jid.String(), struct{}{}); done {
		return
	}
	go func() {
		info, err := a.cli.GetGroupInfo(ctx, jid)
		if err != nil || info.Name == "" {
			return
		}
		a.emit(ctx, map[string]any{"type": "chat", "chat": jid.String(), "name": info.Name, "isGroup": true})
	}()
}

type Media struct {
	Kind     string `json:"kind"`
	Mime     string `json:"mime"`
	Filename string `json:"filename,omitempty"`
	Size     uint64 `json:"size,omitempty"`
	Width    uint32 `json:"width,omitempty"`
	Height   uint32 `json:"height,omitempty"`
}

// extract pulls display text, media metadata and the replied-to message id out of a message.
func extract(m *waE2E.Message) (text string, media *Media, replyTo string) {
	if m == nil {
		return
	}
	var ctxInfo *waE2E.ContextInfo
	switch {
	case m.GetConversation() != "":
		text = m.GetConversation()
	case m.GetExtendedTextMessage() != nil:
		e := m.GetExtendedTextMessage()
		text, ctxInfo = e.GetText(), e.GetContextInfo()
	case m.GetImageMessage() != nil:
		i := m.GetImageMessage()
		text, ctxInfo = i.GetCaption(), i.GetContextInfo()
		media = &Media{Kind: "image", Mime: i.GetMimetype(), Size: i.GetFileLength(), Width: i.GetWidth(), Height: i.GetHeight()}
	case m.GetVideoMessage() != nil:
		v := m.GetVideoMessage()
		text, ctxInfo = v.GetCaption(), v.GetContextInfo()
		media = &Media{Kind: "video", Mime: v.GetMimetype(), Size: v.GetFileLength(), Width: v.GetWidth(), Height: v.GetHeight()}
	case m.GetAudioMessage() != nil:
		au := m.GetAudioMessage()
		ctxInfo = au.GetContextInfo()
		media = &Media{Kind: "audio", Mime: au.GetMimetype(), Size: au.GetFileLength()}
	case m.GetDocumentMessage() != nil:
		d := m.GetDocumentMessage()
		text, ctxInfo = d.GetCaption(), d.GetContextInfo()
		media = &Media{Kind: "document", Mime: d.GetMimetype(), Size: d.GetFileLength(), Filename: d.GetFileName()}
	case m.GetStickerMessage() != nil:
		s := m.GetStickerMessage()
		ctxInfo = s.GetContextInfo()
		media = &Media{Kind: "sticker", Mime: s.GetMimetype(), Size: s.GetFileLength(), Width: s.GetWidth(), Height: s.GetHeight()}
	case m.GetContactMessage() != nil:
		text = "Contact: " + m.GetContactMessage().GetDisplayName()
	case m.GetLocationMessage() != nil:
		l := m.GetLocationMessage()
		text = fmt.Sprintf("Location: https://maps.google.com/?q=%f,%f", l.GetDegreesLatitude(), l.GetDegreesLongitude())
		if l.GetName() != "" {
			text = l.GetName() + "\n" + text
		}
	case m.GetLiveLocationMessage() != nil:
		text = "Shared live location"
	case m.GetPollCreationMessage() != nil:
		text = "Poll: " + m.GetPollCreationMessage().GetName()
	case m.GetPollCreationMessageV3() != nil:
		text = "Poll: " + m.GetPollCreationMessageV3().GetName()
	}
	if ctxInfo != nil {
		replyTo = ctxInfo.GetStanzaID()
	}
	return
}

// ---------- addresses ----------

// chatID returns a stable id for the chat: the group JID, or the other person's phone-number JID for DMs.
func (a *App) chatID(ctx context.Context, src types.MessageSource) string {
	if src.Chat.Server == types.GroupServer {
		return src.Chat.String()
	}
	alt := src.SenderAlt
	if src.IsFromMe {
		alt = src.RecipientAlt
	}
	return a.toPN(ctx, src.Chat, alt).String()
}

func (a *App) toPN(ctx context.Context, j, alt types.JID) types.JID {
	j = j.ToNonAD()
	if j.Server != types.HiddenUserServer {
		return j
	}
	if alt.Server == types.DefaultUserServer {
		return alt.ToNonAD()
	}
	if pn, err := a.cli.Store.LIDs.GetPNForLID(ctx, j); err == nil && !pn.IsEmpty() {
		return pn.ToNonAD()
	}
	return j
}

// address converts a user JID to the hub's handle address: "+15551234567", or "lid:123" if unresolved.
func (a *App) address(ctx context.Context, j, alt types.JID) string {
	return addressFromJID(a.toPN(ctx, j, alt))
}

func addressFromJID(j types.JID) string {
	if j.Server == types.HiddenUserServer {
		return "lid:" + j.User
	}
	if j.Server == types.DefaultUserServer {
		return "+" + j.User
	}
	return j.String()
}

func addressFromJIDString(s string) string {
	j, err := types.ParseJID(s)
	if err != nil {
		return s
	}
	return addressFromJID(j)
}

func jidFromAddress(addr string) (types.JID, error) {
	switch {
	case strings.HasPrefix(addr, "lid:"):
		return types.NewJID(strings.TrimPrefix(addr, "lid:"), types.HiddenUserServer), nil
	case strings.HasPrefix(addr, "+"):
		return types.NewJID(strings.TrimPrefix(addr, "+"), types.DefaultUserServer), nil
	default:
		return types.ParseJID(addr)
	}
}

// ---------- event outbox ----------

func (a *App) emit(ctx context.Context, payload map[string]any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if _, err := a.db.ExecContext(ctx, `insert into wa_event (payload) values ($1)`, data); err != nil {
		a.log.Errorf("emit event: %v", err)
	}
}

// ---------- HTTP API for the hub ----------

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /status", a.auth(a.handleStatus))
	mux.HandleFunc("POST /pair", a.auth(a.handlePair))
	mux.HandleFunc("POST /logout", a.auth(a.handleLogout))
	mux.HandleFunc("POST /send", a.auth(a.handleSend))
	mux.HandleFunc("POST /send-media", a.auth(a.handleSendMedia))
	mux.HandleFunc("POST /read", a.auth(a.handleRead))
	mux.HandleFunc("GET /media", a.auth(a.handleMedia))
	return mux
}

func (a *App) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Internal-Secret")
		if a.secret == "" || subtle.ConstantTimeCompare([]byte(got), []byte(a.secret)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (a *App) handleStatus(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	qr, pairing := a.qr, a.pairing
	a.mu.Unlock()
	res := map[string]any{
		"loggedIn":  a.cli.Store.ID != nil,
		"connected": a.cli.IsConnected(),
		"pairing":   pairing,
		"qr":        qr,
	}
	if a.cli.Store.ID != nil {
		res["jid"] = a.cli.Store.ID.ToNonAD().String()
		res["pushName"] = a.cli.Store.PushName
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *App) handlePair(w http.ResponseWriter, r *http.Request) {
	if a.cli.Store.ID != nil {
		writeErr(w, http.StatusConflict, errors.New("already linked; log out first"))
		return
	}
	go a.pair()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	if err := a.cli.Logout(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	a.emit(r.Context(), map[string]any{"type": "status"})
	go a.pair()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type sendReq struct {
	Chat    string `json:"chat"`
	Text    string `json:"text"`
	ReplyTo *struct {
		ID     string `json:"id"`
		Sender string `json:"sender"` // address of the original sender, "" if it was me
		Text   string `json:"text"`
	} `json:"replyTo"`
}

func (a *App) contextInfo(reply *struct {
	ID     string `json:"id"`
	Sender string `json:"sender"`
	Text   string `json:"text"`
}) *waE2E.ContextInfo {
	if reply == nil || reply.ID == "" {
		return nil
	}
	participant := a.cli.Store.ID.ToNonAD()
	if reply.Sender != "" {
		if j, err := jidFromAddress(reply.Sender); err == nil {
			participant = j
		}
	}
	return &waE2E.ContextInfo{
		StanzaID:      proto.String(reply.ID),
		Participant:   proto.String(participant.String()),
		QuotedMessage: &waE2E.Message{Conversation: proto.String(reply.Text)},
	}
}

func (a *App) handleSend(w http.ResponseWriter, r *http.Request) {
	var req sendReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Chat == "" || req.Text == "" {
		writeErr(w, http.StatusBadRequest, errors.New("chat and text are required"))
		return
	}
	to, err := types.ParseJID(req.Chat)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	msg := &waE2E.Message{}
	if ci := a.contextInfo(req.ReplyTo); ci != nil {
		msg.ExtendedTextMessage = &waE2E.ExtendedTextMessage{Text: proto.String(req.Text), ContextInfo: ci}
	} else {
		msg.Conversation = proto.String(req.Text)
	}
	resp, err := a.cli.SendMessage(r.Context(), to, msg)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": resp.ID, "timestamp": resp.Timestamp.UnixMilli()})
}

func (a *App) handleSendMedia(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(100 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	to, err := types.ParseJID(r.FormValue("chat"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	mime := header.Header.Get("Content-Type")
	if mime == "" || mime == "application/octet-stream" {
		mime = http.DetectContentType(data)
	}
	caption := r.FormValue("caption")

	var mediaType whatsmeow.MediaType
	switch {
	case strings.HasPrefix(mime, "image/") && mime != "image/gif" && mime != "image/heic":
		mediaType = whatsmeow.MediaImage
	case strings.HasPrefix(mime, "video/"):
		mediaType = whatsmeow.MediaVideo
	case strings.HasPrefix(mime, "audio/"):
		mediaType = whatsmeow.MediaAudio
	default:
		mediaType = whatsmeow.MediaDocument
	}
	up, err := a.cli.Upload(r.Context(), data, mediaType)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	msg := &waE2E.Message{}
	switch mediaType {
	case whatsmeow.MediaImage:
		msg.ImageMessage = &waE2E.ImageMessage{
			Caption: proto.String(caption), Mimetype: proto.String(mime), URL: &up.URL, DirectPath: &up.DirectPath,
			MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &up.FileLength,
		}
	case whatsmeow.MediaVideo:
		msg.VideoMessage = &waE2E.VideoMessage{
			Caption: proto.String(caption), Mimetype: proto.String(mime), URL: &up.URL, DirectPath: &up.DirectPath,
			MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &up.FileLength,
		}
	case whatsmeow.MediaAudio:
		msg.AudioMessage = &waE2E.AudioMessage{
			Mimetype: proto.String(mime), URL: &up.URL, DirectPath: &up.DirectPath,
			MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &up.FileLength,
		}
	default:
		msg.DocumentMessage = &waE2E.DocumentMessage{
			Caption: proto.String(caption), Mimetype: proto.String(mime), FileName: proto.String(header.Filename),
			Title: proto.String(header.Filename), URL: &up.URL, DirectPath: &up.DirectPath,
			MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &up.FileLength,
		}
	}
	resp, err := a.cli.SendMessage(r.Context(), to, msg)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	if raw, err := proto.Marshal(msg); err == nil {
		_, _ = a.db.ExecContext(r.Context(),
			`insert into wa_media (chat, id, message) values ($1, $2, $3) on conflict do nothing`, to.String(), resp.ID, raw)
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": resp.ID, "timestamp": resp.Timestamp.UnixMilli(), "mime": mime})
}

func (a *App) handleRead(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Chat     string `json:"chat"`
		Messages []struct {
			ID     string `json:"id"`
			Sender string `json:"sender"`
		} `json:"messages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Chat == "" {
		writeErr(w, http.StatusBadRequest, errors.New("chat is required"))
		return
	}
	chat, err := types.ParseJID(req.Chat)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	bySender := map[string][]types.MessageID{}
	for _, m := range req.Messages {
		bySender[m.Sender] = append(bySender[m.Sender], m.ID)
	}
	for sender, ids := range bySender {
		senderJID := chat
		if chat.Server == types.GroupServer && sender != "" {
			if j, err := jidFromAddress(sender); err == nil {
				senderJID = j
			}
		}
		if err := a.cli.MarkRead(r.Context(), ids, time.Now(), chat, senderJID); err != nil {
			a.log.Warnf("mark read: %v", err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) handleMedia(w http.ResponseWriter, r *http.Request) {
	chat, id := r.URL.Query().Get("chat"), r.URL.Query().Get("id")
	var raw []byte
	if err := a.db.QueryRowContext(r.Context(), `select message from wa_media where chat = $1 and id = $2`, chat, id).Scan(&raw); err != nil {
		writeErr(w, http.StatusNotFound, errors.New("media not found"))
		return
	}
	var m waE2E.Message
	if err := proto.Unmarshal(raw, &m); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	var dl whatsmeow.DownloadableMessage
	var mime string
	switch {
	case m.GetImageMessage() != nil:
		dl, mime = m.GetImageMessage(), m.GetImageMessage().GetMimetype()
	case m.GetVideoMessage() != nil:
		dl, mime = m.GetVideoMessage(), m.GetVideoMessage().GetMimetype()
	case m.GetAudioMessage() != nil:
		dl, mime = m.GetAudioMessage(), m.GetAudioMessage().GetMimetype()
	case m.GetDocumentMessage() != nil:
		dl, mime = m.GetDocumentMessage(), m.GetDocumentMessage().GetMimetype()
	case m.GetStickerMessage() != nil:
		dl, mime = m.GetStickerMessage(), m.GetStickerMessage().GetMimetype()
	default:
		writeErr(w, http.StatusNotFound, errors.New("message has no media"))
		return
	}
	data, err := a.cli.Download(r.Context(), dl)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	if mime == "" {
		mime = http.DetectContentType(data)
	}
	w.Header().Set("Content-Type", mime)
	_, _ = w.Write(data)
}
