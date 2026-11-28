pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

// Start a conversation: pick people (or type a number or email), a service, and write the first message.
// Replaces the conversation pane while it is open (see Main.qml); mirrors the web app's NewMessage.
Item {
    id: nm
    required property Window window
    signal closed()

    // Recipients: { address, name, tid }. Reassigned (never edited in place) so bindings update.
    property var to: []
    property string service: "imessage"
    property bool chosen: false      // the service was picked by hand
    property string error: ""
    property bool sending: false
    property var contacts: []        // the last answer from the hub, for `query`
    property int active: 0
    property var checks: ({})        // address -> { imessage, sms, whatsapp } (empty: couldn't be checked)
    property bool checking: false

    readonly property string query: toInput.text.trim()
    readonly property var single: to.length === 1 ? to[0] : null
    readonly property bool group: to.length > 1
    readonly property var check: single ? (checks[single.address] ?? null) : null
    readonly property var services: [
        { key: "imessage", label: "iMessage", color: Theme.accent },
        { key: "sms", label: "SMS", color: Theme.sms },
        { key: "whatsapp", label: "WhatsApp", color: Theme.whatsapp }
    ]
    readonly property color svcColor: service === "whatsapp" ? Theme.whatsapp : (service === "sms" ? Theme.sms : Theme.accent)

    function isPhone(a) { return a.indexOf("@") < 0; }
    function looksLikeAddress(s) {
        const t = s.trim();
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) || t.replace(/\D/g, "").length >= 7;
    }
    function disabledReason(key) {
        if (key === "whatsapp" && group) return "New WhatsApp groups have to be made on the phone";
        if (key === "sms" && group) return "Group texts start as iMessage";
        if (key !== "imessage" && to.some(r => !isPhone(r.address))) return "Needs a phone number";
        return "";
    }

    readonly property string disabledReasonShown: group ? "Group messages start as iMessage. New WhatsApp groups have to be made on the phone."
        : (to.some(r => !isPhone(r.address)) ? "SMS and WhatsApp need a phone number." : "")

    // One row per address, so a person with a phone number and an email can be reached at either.
    readonly property var options: {
        const rows = [];
        if (query.length < 2) return rows;
        for (const c of contacts) {
            const seen = {};
            for (const a of c.addresses) {
                if (seen[a.address] !== undefined) { if (a.network === "whatsapp") rows[seen[a.address]].whatsapp = true; continue; }
                if (to.some(r => r.address === a.address)) continue;
                seen[a.address] = rows.length;
                rows.push({ name: c.name, address: a.address, tid: c.tid, whatsapp: a.network === "whatsapp" });
            }
        }
        return rows.slice(0, 12);
    }
    onOptionsChanged: active = 0

    function focusTo() { toInput.forceActiveFocus(); }
    function reset() {
        to = []; toInput.text = ""; msg.text = ""; service = "imessage"; chosen = false; error = ""; sending = false; contacts = []; checks = ({});
    }
    onVisibleChanged: if (visible) { reset(); Qt.callLater(focusTo); }

    function add(r) {
        if (!to.some(x => x.address === r.address)) to = to.concat([r]);
        toInput.text = "";
        error = "";
        focusTo();
    }
    function addTyped() {
        const t = query.replace(/[,;]$/, "").trim();
        if (!t) return false;
        if (!looksLikeAddress(t)) {
            error = "Enter a phone number with area code, or an email address.";
            return true;
        }
        add({ address: t, name: "", tid: null });
        return true;
    }
    function pick(o) { add({ address: o.address, name: o.name, tid: o.tid }); }
    function removeAt(i) { to = to.filter((r, k) => k !== i); focusTo(); }
    onToChanged: {
        if (disabledReason(service)) service = "imessage";
        if (group) service = "imessage";
    }

    // Pick a sensible service for one person until it is chosen by hand: iMessage if they have it, else SMS or WhatsApp.
    onCheckChanged: {
        if (chosen || !check || check.imessage === undefined) return;
        if (check.imessage) service = "imessage";
        else if (check.imessage === false && check.sms) service = "sms";
        else if (check.imessage === false && check.whatsapp) service = "whatsapp";
    }
    readonly property string availability: {
        if (!single) return "";
        if (checking && !check) return "Checking which services reach them";
        if (!check) return "";
        const n = single.name || single.address;
        if (service === "imessage" && check.imessage === false) return n + " doesn't seem to have iMessage. It may not be delivered.";
        if (service === "whatsapp" && check.whatsapp === false) return n + " isn't on WhatsApp.";
        return "";
    }

    Timer {
        id: contactTimer
        interval: 200
        onTriggered: if (nm.query.length >= 2) Hub.searchContacts(nm.query)
    }
    Connections {
        target: toInput
        function onTextChanged() {
            nm.error = "";
            if (nm.query.length < 2) { nm.contacts = []; contactTimer.stop(); }
            else contactTimer.restart();
        }
    }
    // Which services reach the one address, a moment after it settles.
    readonly property string checkAddr: single ? single.address : ""
    onCheckAddrChanged: {
        checking = false;
        if (!checkAddr || checks[checkAddr] !== undefined) return;
        checkTimer.restart();
    }
    Timer {
        id: checkTimer
        interval: 300
        onTriggered: {
            if (!nm.checkAddr) return;
            nm.checking = true;
            Hub.checkAddress(nm.checkAddr);
        }
    }
    Connections {
        target: Hub
        function onContactsReady(q, matches) { if (q === nm.query) nm.contacts = matches; }
        function onAddressChecked(address, services) {
            const c = Object.assign({}, nm.checks);
            c[address] = services;
            nm.checks = c;
            if (address === nm.checkAddr) nm.checking = false;
        }
        function onComposeResult(ok, tid, err) {
            if (!nm.visible) return;
            nm.sending = false;
            if (ok) nm.closed();
            else nm.error = err || "Not sent";
        }
    }

    function send() {
        if (sending) return;
        if (query && addTyped()) return;
        if (!to.length) { error = "Add who the message is for."; focusTo(); return; }
        const text = msg.text.trim();
        if (!text) { error = "Write a message to start the conversation."; msg.forceActiveFocus(); return; }
        sending = true;
        error = "";
        Hub.compose(to.map(r => r.address), service, text);
    }

    Rectangle { anchors.fill: parent; color: Theme.bg }

    // ---- header ----
    Rectangle {
        id: bar
        width: parent.width
        height: 52
        color: Theme.glass ? "transparent" : Theme.bg
        z: 2
        DragHandler { target: null; onActiveChanged: if (active) nm.window.startSystemMove() }
        Text {
            anchors.centerIn: parent
            text: "New Message"
            color: Theme.text
            font.family: Theme.boldFont
            font.weight: Font.DemiBold
            font.pixelSize: 13
        }
        Rectangle {
            id: cancel
            anchors.right: parent.right
            anchors.rightMargin: 14 + (Platform.windowControls === "windows" ? 138 : 0)
            anchors.verticalCenter: parent.verticalCenter
            width: cancelText.implicitWidth + 24
            height: 26
            radius: 13
            color: cancelMa.containsMouse ? Theme.ctrlSel : Theme.ctrl
            Text { id: cancelText; anchors.centerIn: parent; text: "Cancel"; color: Theme.text; font.pixelSize: 12 }
            MouseArea { id: cancelMa; anchors.fill: parent; hoverEnabled: true; onClicked: nm.closed() }
        }
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.sep }
    }

    // ---- recipients and service ----
    Item {
        id: body
        anchors.top: bar.bottom
        anchors.bottom: composer.top
        width: parent.width

        Rectangle {
            id: card
            x: 16
            y: 14
            z: 5
            width: Math.min(parent.width - 32, 560)
            height: toRow.height + serviceCol.height + 1
            radius: 12
            color: Theme.card
            border.width: 1
            border.color: Theme.border

            Item {
                id: toRow
                width: parent.width
                height: Math.max(44, flow.height + 16)
                Text {
                    id: toLabel
                    x: 14
                    y: 14
                    text: "To:"
                    color: Theme.text2
                    font.pixelSize: 14
                }
                Flow {
                    id: flow
                    x: 44
                    y: 8
                    width: parent.width - 44 - 12
                    spacing: 6
                    Repeater {
                        model: nm.to
                        delegate: Rectangle {
                            id: chip
                            required property var modelData
                            required property int index
                            height: 28
                            width: chipText.implicitWidth + 34
                            radius: 14
                            color: Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.18)
                            Text {
                                id: chipText
                                x: 12
                                anchors.verticalCenter: parent.verticalCenter
                                text: chip.modelData.name || chip.modelData.address
                                color: Theme.accent
                                font.pixelSize: 13
                            }
                            Glyph {
                                x: parent.width - 20
                                anchors.verticalCenter: parent.verticalCenter
                                name: "clear"
                                width: 12
                                height: 12
                                color: Theme.accent
                                opacity: 0.8
                                MouseArea { anchors.fill: parent; anchors.margins: -6; onClicked: nm.removeAt(chip.index) }
                            }
                        }
                    }
                    TextInput {
                        id: toInput
                        width: nm.to.length ? 170 : flow.width - 8
                        height: 28
                        verticalAlignment: TextInput.AlignVCenter
                        color: Theme.text
                        selectionColor: Theme.accent
                        selectedTextColor: "white"
                        font.pixelSize: 14
                        clip: true
                        onActiveFocusChanged: if (!activeFocus && nm.query && nm.looksLikeAddress(nm.query) && !nm.sending && nm.visible && !nm.options.length) nm.addTyped()
                        Keys.onPressed: event => {
                            const n = nm.options.length;
                            if (event.key === Qt.Key_Down && n) { nm.active = (nm.active + 1) % n; event.accepted = true; }
                            else if (event.key === Qt.Key_Up && n) { nm.active = (nm.active + n - 1) % n; event.accepted = true; }
                            else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Tab) {
                                if (!nm.query) {
                                    if (event.key !== Qt.Key_Tab && nm.to.length) msg.forceActiveFocus();
                                    event.accepted = event.key !== Qt.Key_Tab;
                                    return;
                                }
                                event.accepted = true;
                                if (nm.options[nm.active]) nm.pick(nm.options[nm.active]);
                                else nm.addTyped();
                            } else if (event.text === "," || event.text === ";") {
                                event.accepted = true;
                                if (nm.query) nm.addTyped();
                            } else if (event.key === Qt.Key_Backspace && !text && nm.to.length) {
                                nm.to = nm.to.slice(0, -1);
                                event.accepted = true;
                            } else if (event.key === Qt.Key_Escape) {
                                event.accepted = true;
                                if (text) text = ""; else nm.closed();
                            }
                        }
                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: "Name, phone number or email"
                            color: Theme.text3
                            font.pixelSize: 14
                            visible: !toInput.text && !toInput.preeditText && nm.to.length === 0
                        }
                    }
                }
                MouseArea { anchors.fill: parent; z: -1; onClicked: nm.focusTo() }
            }
            Rectangle { y: toRow.height; width: parent.width; height: 1; color: Theme.sep }

            Column {
                id: serviceCol
                y: toRow.height + 1
                width: parent.width
                padding: 12
                spacing: 8
                Row {
                    spacing: 0
                    Rectangle {
                        width: segRow.width + 4
                        height: 30
                        radius: 9
                        color: Theme.ctrl
                        Row {
                            id: segRow
                            x: 2
                            y: 2
                            spacing: 2
                            Repeater {
                                model: nm.services
                                delegate: Rectangle {
                                    id: seg
                                    required property var modelData
                                    readonly property bool on: nm.service === modelData.key
                                    readonly property string why: nm.disabledReason(modelData.key)
                                    width: segText.implicitWidth + 28
                                    height: 26
                                    radius: 7
                                    color: on ? modelData.color : "transparent"
                                    opacity: why ? 0.4 : 1
                                    Text {
                                        id: segText
                                        anchors.centerIn: parent
                                        text: seg.modelData.label
                                        color: seg.on ? "white" : Theme.text
                                        font.pixelSize: 12
                                        font.family: Theme.boldFont
                                        font.weight: Font.DemiBold
                                    }
                                    MouseArea {
                                        anchors.fill: parent
                                        enabled: !seg.why
                                        onClicked: { nm.service = seg.modelData.key; nm.chosen = true; msg.forceActiveFocus(); }
                                    }
                                }
                            }
                        }
                    }
                }
                Text {
                    visible: nm.disabledReasonShown.length > 0
                    width: parent.width - 24
                    text: nm.disabledReasonShown
                    color: Theme.text3
                    font.pixelSize: 12
                    wrapMode: Text.Wrap
                }
                Text {
                    visible: nm.availability.length > 0
                    width: parent.width - 24
                    text: nm.availability
                    color: Theme.text2
                    font.pixelSize: 12
                    wrapMode: Text.Wrap
                }
                Row {
                    visible: !!nm.single && !!nm.single.tid
                    width: parent.width - 24
                    spacing: 4
                    Text {
                        text: nm.single ? "You already have a conversation with " + (nm.single.name || nm.single.address) + " -" : ""
                        color: Theme.text2
                        font.pixelSize: 12
                    }
                    Text {
                        text: "Open it"
                        color: Theme.accent
                        font.pixelSize: 12
                        MouseArea {
                            anchors.fill: parent
                            anchors.margins: -3
                            cursorShape: Qt.PointingHandCursor
                            onClicked: { const t = nm.single.tid; Hub.openThread(t); nm.closed(); }
                        }
                    }
                }
            }

            // Suggestions float over the card's lower half and what is below it.
            Rectangle {
                id: sugg
                visible: nm.query.length >= 2 && (nm.options.length > 0 || nm.contacts.length === 0)
                y: toRow.height + 4
                width: parent.width
                height: suggCol.height + 8
                radius: 12
                color: Theme.card
                border.width: 1
                border.color: Theme.border
                z: 10
                GlassEdge { anchors.fill: parent; visible: Theme.glass; radius: sugg.radius; rim: Theme.edgeLight * 0.8 }
                Column {
                    id: suggCol
                    x: 4
                    y: 4
                    width: parent.width - 8
                    Text {
                        visible: nm.options.length === 0
                        padding: 10
                        width: parent.width
                        wrapMode: Text.Wrap
                        text: nm.looksLikeAddress(nm.query) ? "Press Enter to send to " + nm.query + "." : "No one matches. Type a phone number or email."
                        color: Theme.text2
                        font.pixelSize: 12
                    }
                    Repeater {
                        model: nm.options
                        delegate: Rectangle {
                            id: opt
                            required property var modelData
                            required property int index
                            width: suggCol.width
                            height: 44
                            radius: 8
                            color: index === nm.active ? Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.22) : "transparent"
                            Avatar {
                                id: ava
                                x: 8
                                anchors.verticalCenter: parent.verticalCenter
                                size: 30
                                initials: {
                                    const p = opt.modelData.name.trim().split(/\s+/);
                                    return ((p[0] ?? "")[0] ?? "#").toUpperCase() + (p.length > 1 ? p[p.length - 1][0].toUpperCase() : "");
                                }
                            }
                            Column {
                                anchors.left: ava.right
                                anchors.leftMargin: 10
                                anchors.right: parent.right
                                anchors.rightMargin: 10
                                anchors.verticalCenter: parent.verticalCenter
                                Text {
                                    width: parent.width
                                    elide: Text.ElideRight
                                    text: opt.modelData.name
                                    color: Theme.text
                                    font.pixelSize: 13
                                    font.family: Theme.boldFont
                                    font.weight: Font.DemiBold
                                }
                                Text {
                                    width: parent.width
                                    elide: Text.ElideRight
                                    text: opt.modelData.address + (opt.modelData.whatsapp ? "  WhatsApp" : "")
                                    color: Theme.text2
                                    font.pixelSize: 12
                                }
                            }
                            MouseArea {
                                anchors.fill: parent
                                hoverEnabled: true
                                onEntered: nm.active = opt.index
                                onClicked: nm.pick(opt.modelData)
                            }
                        }
                    }
                }
            }
        }

        Text {
            visible: nm.error.length > 0
            anchors.top: card.bottom
            anchors.topMargin: 12
            x: 20
            width: card.width - 8
            text: nm.error
            color: Theme.danger
            font.pixelSize: 13
            wrapMode: Text.Wrap
        }
    }

    // ---- first message ----
    Rectangle {
        id: composer
        anchors.bottom: parent.bottom
        width: parent.width
        height: field.height + 22
        color: Theme.glass ? "transparent" : Theme.bg
        Rectangle { width: parent.width; height: 1; color: Theme.sep }
        Rectangle {
            id: field
            x: 14
            y: 10
            width: parent.width - 28
            height: Math.min(Math.max(34, msg.contentHeight + 16), 140)
            radius: 17
            color: Theme.glass ? Theme.card : "transparent"
            border.width: 1
            border.color: msg.activeFocus ? Qt.rgba(Theme.text.r, Theme.text.g, Theme.text.b, 0.25) : Theme.border
            GlassEdge { anchors.fill: parent; visible: Theme.glass; radius: field.radius; rim: Theme.edgeLight * 0.8 }
            Flickable {
                id: flick
                anchors.fill: parent
                anchors.leftMargin: 14
                anchors.rightMargin: 38
                anchors.topMargin: 8
                anchors.bottomMargin: 8
                contentWidth: width
                contentHeight: msg.contentHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                function ensureVisible(r) {
                    if (contentY >= r.y) contentY = r.y;
                    else if (contentY + height <= r.y + r.height) contentY = r.y + r.height - height;
                }
                TextEdit {
                    id: msg
                    width: flick.width
                    wrapMode: TextEdit.Wrap
                    color: Theme.text
                    selectionColor: Theme.accent
                    selectedTextColor: "white"
                    font.pixelSize: 14
                    onCursorRectangleChanged: flick.ensureVisible(cursorRectangle)
                    onTextChanged: nm.error = ""
                    Keys.onReturnPressed: event => { if (event.modifiers & Qt.ShiftModifier) event.accepted = false; else nm.send(); }
                    Keys.onEnterPressed: nm.send()
                    Keys.onEscapePressed: nm.closed()
                    Text {
                        text: nm.services.find(s => s.key === nm.service).label
                        color: Theme.text3
                        font.pixelSize: 14
                        visible: !msg.text && !msg.preeditText
                    }
                }
            }
            Rectangle {
                anchors.right: parent.right
                anchors.rightMargin: 4
                anchors.bottom: parent.bottom
                anchors.bottomMargin: 4
                width: 26
                height: 26
                radius: 13
                visible: msg.text.trim().length > 0
                color: nm.svcColor
                opacity: nm.sending ? 0.5 : 1
                Glyph { anchors.centerIn: parent; name: "up"; width: 14; height: 14; color: "white"; stroke: 2 }
                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: nm.send() }
            }
        }
    }
}
