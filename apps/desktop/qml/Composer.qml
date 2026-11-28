pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

Rectangle {
    id: c
    property var conversations: []
    property var replyTo: null
    property int picked: 0  // index into conversations; the newest conversation comes first
    readonly property var conv: conversations.length ? conversations[Math.min(picked, conversations.length - 1)] : null
    readonly property int conversationId: conv ? conv.id : 0
    readonly property string serviceName: {
        const s = conv ? conv.lastService : "imessage";
        return s === "whatsapp" ? "WhatsApp" : s === "sms" ? "Text Message" : s === "rcs" ? "Text Message · RCS" : "iMessage";
    }
    signal sent()
    signal cancelReply()
    // Ask for a time to send the text later (the view shows the picker); the box clears once it is scheduled.
    signal scheduleRequested(string text, int conversationId, int replyToId)
    function scheduled() { input.clear(); c.sent(); }
    function scheduleLater() {
        const text = input.text.trim();
        if (text) c.scheduleRequested(text, c.conversationId, c.replyTo ? c.replyTo.id : 0);
    }

    function focusInput() { input.forceActiveFocus(); }
    function send() {
        if (Hub.recording) { Hub.stopRecording(true); return; }
        const text = input.text.trim();
        if (c.staged.length) {
            // The files go first, the text as the last one's caption.
            Hub.sendFiles(c.staged.map(f => f.url), c.conversationId, text);
            c.staged = [];
        } else if (text) {
            Hub.send(text, c.conversationId, c.replyTo ? c.replyTo.id : 0);
        } else return;
        c.stopTyping();
        input.clear();
        Hub.setDraft(c.draftTid, "");
        c.sent();
    }
    onConversationsChanged: picked = 0
    readonly property bool canSend: input.text.trim().length > 0 || staged.length > 0

    // ---- files waiting to be sent: dropped, picked with +, or pasted (Ctrl+V) ----
    property var staged: []  // [{ url, name, image }]
    function stage(urls) {
        const next = c.staged.slice();
        for (const u of urls) {
            const url = String(u);
            if (next.length >= 10 || next.some(f => f.url === url)) continue;
            const name = decodeURIComponent(url.replace(/[?#].*$/, "").split("/").pop() || "File");
            next.push({ url: url, name: name, image: /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(name) });
        }
        c.staged = next;
        c.focusInput();
    }
    function unstage(i) { const next = c.staged.slice(); next.splice(i, 1); c.staged = next; }

    // ---- drafts: each chat keeps what was typed in it ----
    property string draftTid: ""
    property bool loadingDraft: false
    function switchThread() {
        if (Hub.currentTid === c.draftTid) return;
        if (c.draftTid) Hub.setDraft(c.draftTid, input.text);
        c.stopTyping();
        if (Hub.recording) Hub.stopRecording(false);
        c.staged = [];
        c.draftTid = Hub.currentTid;
        c.loadingDraft = true;
        input.text = Hub.draft(c.draftTid);
        input.cursorPosition = input.length;
        c.loadingDraft = false;
    }
    Connections {
        target: Hub
        function onCurrentChanged() { c.switchThread(); }
        function onFilesChosen(files, conversationId) { c.stage(files); }
    }
    Component.onCompleted: switchThread()
    Component.onDestruction: if (c.draftTid) Hub.setDraft(c.draftTid, input.text)  // the window closed
    Timer { id: draftTimer; interval: 400; onTriggered: Hub.setDraft(c.draftTid, input.text) }

    // ---- my typing indicator: "typing" repeats every 3 s while keys are pressed, "stopped" after 5 s of quiet ----
    property bool typingOn: false
    property real typingAt: 0
    property int typingConv: 0
    property string typingTid: ""
    Timer { id: typingIdle; interval: 5000; onTriggered: c.stopTyping() }
    function noteTyping() {
        if (!input.text.trim()) { c.stopTyping(); return; }
        const now = Date.now();
        if (c.typingOn && c.typingConv !== c.conversationId) c.stopTyping();
        if (!c.typingOn || now - c.typingAt > 3000) {
            Hub.sendTyping(Hub.currentTid, c.conversationId, true);
            c.typingOn = true;
            c.typingAt = now;
            c.typingConv = c.conversationId;
            c.typingTid = Hub.currentTid;
        }
        typingIdle.restart();
    }
    function stopTyping() {
        typingIdle.stop();
        if (c.typingOn) Hub.sendTyping(c.typingTid, c.typingConv, false);
        c.typingOn = false;
    }

    // ---- voice messages ----
    property real recordStart: 0
    property int recordSecs: 0
    Connections {
        target: Hub
        function onRecordingChanged() { c.recordStart = Date.now(); c.recordSecs = 0; }
    }
    Timer { interval: 250; repeat: true; running: Hub.recording; onTriggered: c.recordSecs = Math.floor((Date.now() - c.recordStart) / 1000) }

    // :emoji: shortcodes. Typing ":smi" opens a list above the caret; Enter or Tab inserts, Esc closes, and a finished ":smile:" converts at once.
    property int trigStart: -1
    property int closedAt: -1
    property int active: 0
    property var matches: []
    readonly property bool emojiOpen: matches.length > 0
    function refreshEmoji() {
        const t = SearchAssist.emojiTrigger(input.text, input.cursorPosition);
        if (t.start === undefined || t.start === c.closedAt) { trigStart = -1; matches = []; return; }
        const m = SearchAssist.emojiSearch(t.query, 8);
        if (t.start !== trigStart || m.length !== matches.length) active = 0;
        trigStart = t.start;
        matches = m;
    }
    property bool converting: false
    function emojiEdited() {
        if (converting) return;
        converting = true;
        const done = SearchAssist.emojiComplete(input.text, input.cursorPosition);
        if (done.start !== undefined) {
            const end = input.cursorPosition;
            input.remove(done.start, end);
            input.insert(done.start, done.emoji);
            input.cursorPosition = done.start + done.emoji.length;
        }
        converting = false;
        if (input.text !== lastText) { lastText = input.text; closedAt = -1; }
        refreshEmoji();
    }
    property string lastText: ""
    function pickEmoji(i) {
        const m = matches[i];
        if (!m) return;
        // Editing the text re-runs the lookup, which clears these, so take what is needed first.
        const start = trigStart;
        const end = input.cursorPosition;
        const gap = /^\s/.test(input.text.slice(end, end + 1)) ? "" : " ";
        converting = true;
        input.remove(start, end);
        input.insert(start, m.emoji + gap);
        input.cursorPosition = start + m.emoji.length + gap.length;
        converting = false;
        closedAt = -1;
        refreshEmoji();
    }

    color: Theme.glass ? "transparent" : Theme.bg  // with glass the pane's tint is behind it
    height: col.height + 14

    Rectangle { width: parent.width; height: 1; color: Theme.sep }

    Column {
        id: col
        y: 8
        width: parent.width
        spacing: 6

        // Which service to reply on, when this person has more than one chat.
        Row {
            visible: c.conversations.length > 1
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: 6
            Repeater {
                model: c.conversations
                delegate: Rectangle {
                    id: pill
                    required property var modelData
                    required property int index
                    readonly property bool on: c.picked === index
                    readonly property string label: modelData.network === "whatsapp" ? "WhatsApp" : (modelData.lastService === "imessage" ? "iMessage" : "Text Message")
                    width: pillText.implicitWidth + 20
                    height: 22
                    radius: 11
                    color: on ? (modelData.network === "whatsapp" ? Theme.whatsapp : (modelData.lastService === "imessage" ? Theme.accent : Theme.sms)) : Theme.ctrl
                    Text { id: pillText; anchors.centerIn: parent; text: pill.label; color: pill.on ? "white" : Theme.text2; font.pixelSize: 11; font.family: Theme.boldFont; font.weight: Font.DemiBold }
                    MouseArea { anchors.fill: parent; onClicked: { c.picked = pill.index; c.focusInput(); } }
                }
            }
        }

        // Files waiting to be sent, with a way to take each one out.
        Flickable {
            visible: c.staged.length > 0
            x: 52
            width: parent.width - 66
            height: visible ? 64 : 0
            contentWidth: stagedRow.width
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            Row {
                id: stagedRow
                y: 4
                spacing: 8
                Repeater {
                    model: c.staged
                    delegate: Rectangle {
                        id: chip
                        required property var modelData
                        required property int index
                        width: modelData.image ? 56 : Math.min(180, chipName.implicitWidth + 44)
                        height: 56
                        radius: 10
                        color: Theme.ctrl
                        clip: true
                        Image {
                            anchors.fill: parent
                            visible: chip.modelData.image
                            source: chip.modelData.image ? chip.modelData.url : ""
                            sourceSize: Qt.size(112, 112)
                            fillMode: Image.PreserveAspectCrop
                            asynchronous: true
                        }
                        Row {
                            visible: !chip.modelData.image
                            x: 10
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: 6
                            Glyph { name: "file"; width: 16; height: 16; color: Theme.text2; anchors.verticalCenter: parent.verticalCenter }
                            Text { id: chipName; width: Math.min(implicitWidth, 130); elide: Text.ElideMiddle; text: chip.modelData.name; color: Theme.text; font.pixelSize: 12; anchors.verticalCenter: parent.verticalCenter }
                        }
                        Glyph {
                            anchors.right: parent.right
                            anchors.top: parent.top
                            anchors.margins: 3
                            name: "clear"
                            width: 16
                            height: 16
                            color: Qt.rgba(0, 0, 0, 0.6)
                            MouseArea { anchors.fill: parent; anchors.margins: -3; cursorShape: Qt.PointingHandCursor; onClicked: c.unstage(chip.index) }
                        }
                    }
                }
            }
        }

        Rectangle {
            visible: !!c.replyTo
            x: 52
            width: parent.width - 104
            height: 30
            radius: 8
            color: Theme.ctrl
            Glyph { x: 8; anchors.verticalCenter: parent.verticalCenter; name: "reply"; width: 14; height: 14; color: Theme.text2 }
            Text {
                x: 28
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width - 56
                elide: Text.ElideRight
                text: c.replyTo ? "Replying to " + c.replyTo.name + ": " + (c.replyTo.body || "") : ""
                color: Theme.text2
                font.pixelSize: 12
            }
            Glyph {
                anchors.right: parent.right
                anchors.rightMargin: 8
                anchors.verticalCenter: parent.verticalCenter
                name: "clear"
                width: 14
                height: 14
                color: Theme.text3
                MouseArea { anchors.fill: parent; anchors.margins: -4; onClicked: c.cancelReply() }
            }
        }

        Item {
            width: parent.width
            height: field.height

            Rectangle {
                id: attach
                x: 14
                anchors.bottom: parent.bottom
                anchors.bottomMargin: (34 - height) / 2
                width: 28
                height: 28
                radius: 14
                color: attachMa.containsMouse ? Qt.darker(Theme.ctrl, 1.2) : Theme.ctrl
                Glyph { anchors.centerIn: parent; name: "plus"; width: 14; height: 14; color: Theme.text2; stroke: 1.8 }
                MouseArea { id: attachMa; anchors.fill: parent; hoverEnabled: true; onClicked: Hub.pickFile(c.conversationId) }
            }

            Rectangle {
                id: field
                anchors.left: attach.right
                anchors.leftMargin: 10
                anchors.right: parent.right
                anchors.rightMargin: 14
                height: Math.min(Math.max(34, input.contentHeight + 16), 140)
                radius: 17
                // Over glass the field is solid, so what you type always reads well, and its edge catches the light.
                color: Theme.glass ? Theme.card : "transparent"
                border.width: 1
                border.color: input.activeFocus ? Qt.rgba(Theme.text.r, Theme.text.g, Theme.text.b, 0.25) : Theme.border

                GlassEdge {
                    anchors.fill: parent
                    visible: Theme.glass
                    radius: field.radius
                    rim: Theme.edgeLight * 0.8
                }

                Flickable {
                    id: flick
                    anchors.fill: parent
                    anchors.leftMargin: 14
                    anchors.rightMargin: input.text.trim().length > 0 && !c.staged.length ? 66 : 38
                    visible: !Hub.recording
                    anchors.topMargin: 8
                    anchors.bottomMargin: 8
                    contentWidth: width
                    contentHeight: input.contentHeight
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    function ensureVisible(r) {
                        if (contentY >= r.y) contentY = r.y;
                        else if (contentY + height <= r.y + r.height) contentY = r.y + r.height - height;
                    }
                    TextEdit {
                        id: input
                        width: flick.width
                        wrapMode: TextEdit.Wrap
                        color: Theme.text
                        selectionColor: Theme.accent
                        selectedTextColor: "white"
                        font.pixelSize: 14
                        onCursorRectangleChanged: flick.ensureVisible(cursorRectangle)
                        // Typing changes the text first and the cursor just after, so both signals look for a finished ":smile:".
                        onTextChanged: {
                            c.emojiEdited();
                            if (!c.loadingDraft) { draftTimer.restart(); c.noteTyping(); }
                        }
                        onActiveFocusChanged: if (!activeFocus) c.stopTyping()
                        onCursorPositionChanged: c.emojiEdited()
                        Keys.onPressed: event => {
                            // Pasting a picture or copied files adds them to the message; text pastes as usual.
                            if (event.matches(StandardKey.Paste)) {
                                const files = Hub.pasteFiles();
                                if (files.length) { c.stage(files); event.accepted = true; }
                                return;
                            }
                            if (!c.emojiOpen) return;
                            if (event.key === Qt.Key_Down || event.key === Qt.Key_Up) {
                                c.active = (c.active + (event.key === Qt.Key_Down ? 1 : -1) + c.matches.length) % c.matches.length;
                                event.accepted = true;
                            } else if (event.key === Qt.Key_Tab) {
                                c.pickEmoji(c.active);
                                event.accepted = true;
                            }
                        }
                        // The key-specific handlers run before Keys.onPressed, so while the emoji list is open they take Enter and Esc here.
                        Keys.onReturnPressed: event => {
                            if (c.emojiOpen) c.pickEmoji(c.active);
                            else if (event.modifiers & Qt.ShiftModifier) event.accepted = false;
                            else c.send();
                        }
                        Keys.onEnterPressed: event => { if (c.emojiOpen) c.pickEmoji(c.active); else c.send(); }
                        Keys.onEscapePressed: {
                            if (Hub.recording) Hub.stopRecording(false);
                            else if (c.emojiOpen) { c.closedAt = c.trigStart; c.refreshEmoji(); }
                            else if (c.replyTo) c.cancelReply();
                        }
                        Text {
                            text: c.serviceName
                            color: Theme.text3
                            font.pixelSize: 14
                            visible: !input.text && !input.preeditText
                        }
                    }
                }

                // Send later: opens the schedule picker for what is typed.
                Rectangle {
                    id: later
                    anchors.right: parent.right
                    anchors.rightMargin: 34
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: 4
                    width: 26
                    height: 26
                    radius: 13
                    visible: input.text.trim().length > 0 && !c.staged.length && !Hub.recording
                    color: laterMa.containsMouse ? Theme.ctrlSel : Theme.ctrl
                    Canvas {
                        anchors.centerIn: parent
                        width: 14
                        height: 14
                        property color tint: Theme.text2
                        onTintChanged: requestPaint()
                        onPaint: {
                            const g = getContext("2d");
                            g.reset();
                            g.strokeStyle = tint;
                            g.lineWidth = 1.5;
                            g.lineCap = "round";
                            g.lineJoin = "round";
                            g.beginPath();
                            g.arc(7, 7, 5.8, 0, Math.PI * 2);
                            g.moveTo(7, 3.6); g.lineTo(7, 7); g.lineTo(9.4, 8.4);
                            g.stroke();
                        }
                    }
                    MouseArea { id: laterMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: c.scheduleLater() }
                }

                Rectangle {
                    anchors.right: parent.right
                    anchors.rightMargin: 4
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: 4
                    width: 26
                    height: 26
                    radius: 13
                    visible: c.canSend || Hub.recording
                    color: c.conv && c.conv.network === "whatsapp" ? Theme.whatsapp : (c.conv && c.conv.lastService !== "imessage" ? Theme.sms : Theme.accent)
                    Glyph { anchors.centerIn: parent; name: "up"; width: 14; height: 14; color: "white"; stroke: 2 }
                    // Right-click Send to schedule instead.
                    MouseArea {
                        anchors.fill: parent
                        acceptedButtons: Qt.LeftButton | Qt.RightButton
                        onClicked: mouse => { if (mouse.button === Qt.RightButton) c.scheduleLater(); else c.send(); }
                    }
                }

                // Record a voice message (shown while the box is empty).
                Rectangle {
                    anchors.right: parent.right
                    anchors.rightMargin: 4
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: 4
                    width: 26
                    height: 26
                    radius: 13
                    visible: !c.canSend && !Hub.recording && c.conversationId > 0
                    color: micMa.containsMouse ? Theme.ctrlSel : Theme.ctrl
                    Text { anchors.centerIn: parent; text: "\u{1F399}\uFE0F"; font.pixelSize: 13 }
                    MouseArea {
                        id: micMa
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: Hub.startRecording(c.conversationId)
                    }
                }

                // While recording: how long so far, and Cancel (Send is the arrow).
                Row {
                    visible: Hub.recording
                    x: 14
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 8
                    Rectangle {
                        width: 9
                        height: 9
                        radius: 4.5
                        color: Theme.danger
                        anchors.verticalCenter: parent.verticalCenter
                        SequentialAnimation on opacity {
                            running: Hub.recording
                            loops: Animation.Infinite
                            NumberAnimation { from: 1; to: 0.3; duration: 600 }
                            NumberAnimation { from: 0.3; to: 1; duration: 600 }
                        }
                    }
                    Text {
                        text: "Recording  " + Math.floor(c.recordSecs / 60) + ":" + String(c.recordSecs % 60).padStart(2, "0")
                        color: Theme.text
                        font.pixelSize: 14
                        anchors.verticalCenter: parent.verticalCenter
                    }
                    Text {
                        text: "Cancel"
                        color: Theme.accent
                        font.pixelSize: 13
                        anchors.verticalCenter: parent.verticalCenter
                        MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: Hub.stopRecording(false) }
                    }
                }
            }
        }
    }

    Rectangle {
        id: emojiPopup
        visible: c.emojiOpen
        z: 100
        readonly property point caretPos: c.emojiOpen ? input.mapToItem(c, input.positionToRectangle(c.trigStart).x, input.positionToRectangle(c.trigStart).y) : Qt.point(0, 0)
        x: Math.max(8, Math.min(caretPos.x, c.width - width - 8))
        y: caretPos.y - height - 6
        width: 260
        height: emojiCol.height + 8
        radius: 10
        color: Theme.card
        border.width: 1
        border.color: Theme.border
        GlassEdge { anchors.fill: parent; visible: Theme.glass; radius: emojiPopup.radius; rim: Theme.edgeLight * 0.8 }
        Column {
            id: emojiCol
            x: 4
            y: 4
            width: parent.width - 8
            Repeater {
                model: c.matches
                delegate: Rectangle {
                    id: erow
                    required property var modelData
                    required property int index
                    width: emojiCol.width
                    height: 30
                    radius: 7
                    color: index === c.active ? Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.3) : "transparent"
                    Text { id: glyph; x: 8; anchors.verticalCenter: parent.verticalCenter; text: erow.modelData.emoji; font.pixelSize: 18; width: 26 }
                    Text {
                        anchors.left: glyph.right
                        anchors.leftMargin: 8
                        anchors.right: parent.right
                        anchors.rightMargin: 6
                        anchors.verticalCenter: parent.verticalCenter
                        elide: Text.ElideRight
                        text: ":" + erow.modelData.name + ":"
                        color: Theme.text
                        font.pixelSize: 13
                    }
                    MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        onEntered: c.active = erow.index
                        onClicked: { c.pickEmoji(erow.index); input.forceActiveFocus(); }
                    }
                }
            }
        }
    }
}
