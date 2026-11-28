pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

// "Schedule Message": quick times and a date and time picker built from plain Quick items (a month grid and two steppers).
// Times are in this computer's time zone; the hub's zone is shown when it differs. open() to show, accepted(text, ms) when confirmed.
Item {
    id: p
    anchors.fill: parent
    visible: false
    z: 900

    property string title: "Schedule Message"
    property string okLabel: "Schedule"
    property bool editable: false   // the message is a text box (editing), otherwise a preview
    property string text: ""
    property string error: ""
    property bool busy: false
    signal accepted(string text, double ms)
    signal saved()  // the hub took it

    // The chosen moment.
    property date when: new Date()
    property int viewYear: 0
    property int viewMonth: 0   // 0-11
    readonly property bool h24: Theme.use24h
    readonly property bool past: when.getTime() < Date.now() + 5000
    readonly property bool differs: Hub.hubTimeZone.length > 0 && Hub.hubTimeZone !== Hub.localTimeZone() && Hub.inHubZone(when.getTime()).length > 0

    function open(msg, whenMs, edit) {
        text = msg;
        editable = edit;
        error = "";
        busy = false;
        // Start from the given time, otherwise tomorrow at 9:00.
        let ms = whenMs;
        if (ms <= 0) {
            ms = Date.now() + 3600000;
            for (const q of Hub.quickTimes()) if (q.label === "Tomorrow") ms = q.ms;
        }
        setWhen(new Date(ms));
        visible = true;
        if (edit) input.forceActiveFocus(); else p.forceActiveFocus();
    }
    function close() { visible = false; }
    function setWhen(d) {
        when = d;
        viewYear = d.getFullYear();
        viewMonth = d.getMonth();
    }
    function pickDay(y, m, day) {
        const d = new Date(when);
        d.setFullYear(y, m, day);
        setWhen(d);
    }
    function addMinutes(n) {
        setWhen(new Date(when.getTime() + n * 60000));
    }
    function setHour(h) {
        const d = new Date(when);
        d.setHours(h);
        setWhen(d);
    }
    function submit() {
        if (busy || past || !text.trim().length) return;
        busy = true;
        error = "";
        accepted(p.editable ? input.text : p.text, when.getTime());
    }
    Connections {
        target: Hub
        enabled: p.visible
        function onScheduleResult(ok, err) {
            p.busy = false;
            if (ok) { p.saved(); p.close(); } else p.error = err;
        }
    }

    Keys.onEscapePressed: close()

    // Dim the pane behind and swallow clicks.
    Rectangle { anchors.fill: parent; color: Qt.rgba(0, 0, 0, Theme.dark ? 0.5 : 0.25) }
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onClicked: if (!p.busy) p.close(); onWheel: wheel => wheel.accepted = true }

    Rectangle {
        id: card
        anchors.centerIn: parent
        width: Math.min(p.width - 32, 400)
        height: Math.min(p.height - 24, content.height + 36)
        radius: 16
        color: Theme.dark ? Qt.rgba(0.15, 0.15, 0.16, 0.98) : Qt.rgba(0.98, 0.98, 0.99, 0.99)
        border.width: 1
        border.color: Theme.border
        MouseArea { anchors.fill: parent }  // clicks on the card don't reach the backdrop

        Flickable {
            anchors.fill: parent
            anchors.margins: 18
            contentWidth: width
            contentHeight: content.height
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            Column {
                id: content
                width: parent.width
                spacing: 12

                Text { text: p.title; color: Theme.text; font.pixelSize: 16; font.family: Theme.boldFont; font.weight: Font.DemiBold }

                // The message: a preview, or editable.
                Rectangle {
                    width: parent.width
                    height: p.editable ? Math.min(Math.max(44, input.contentHeight + 20), 120) : Math.min(preview.implicitHeight + 20, 90)
                    radius: 10
                    color: Theme.ctrl
                    border.width: p.editable && input.activeFocus ? 2 : 1
                    border.color: p.editable && input.activeFocus ? Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.55) : Theme.sep
                    clip: true
                    Text {
                        id: preview
                        visible: !p.editable
                        x: 10
                        y: 10
                        width: parent.width - 20
                        text: p.text
                        color: Theme.text
                        font.pixelSize: 13
                        wrapMode: Text.Wrap
                        elide: Text.ElideRight
                        maximumLineCount: 4
                    }
                    TextEdit {
                        id: input
                        visible: p.editable
                        x: 10
                        y: 10
                        width: parent.width - 20
                        text: p.editable ? p.text : ""
                        color: Theme.text
                        selectionColor: Theme.accent
                        selectedTextColor: "white"
                        font.pixelSize: 13
                        wrapMode: TextEdit.Wrap
                    }
                }

                // Quick times.
                Flow {
                    width: parent.width
                    spacing: 8
                    Repeater {
                        model: Hub.quickTimes()
                        delegate: Rectangle {
                            id: qt
                            required property var modelData
                            readonly property bool on: Math.abs(p.when.getTime() - modelData.ms) < 1000
                            width: qcol.width + 24
                            height: 40
                            radius: 10
                            color: on ? Theme.accent : (qma.containsMouse ? Qt.darker(Theme.ctrl, 1.15) : Theme.ctrl)
                            Column {
                                id: qcol
                                anchors.centerIn: parent
                                Text { anchors.horizontalCenter: parent.horizontalCenter; text: qt.modelData.label; color: qt.on ? "white" : Theme.text; font.pixelSize: 13; font.family: Theme.boldFont; font.weight: Font.DemiBold }
                                Text { anchors.horizontalCenter: parent.horizontalCenter; text: qt.modelData.time; color: qt.on ? Qt.rgba(1, 1, 1, 0.85) : Theme.text2; font.pixelSize: 11 }
                            }
                            MouseArea { id: qma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: p.setWhen(new Date(qt.modelData.ms)) }
                        }
                    }
                }

                // Month grid.
                Item {
                    width: parent.width
                    height: 22
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: Qt.locale().monthName(p.viewMonth, Locale.LongFormat) + " " + p.viewYear
                        color: Theme.text
                        font.pixelSize: 13
                        font.family: Theme.boldFont
                        font.weight: Font.DemiBold
                    }
                    Row {
                        anchors.right: parent.right
                        spacing: 4
                        Repeater {
                            model: ["‹", "›"]
                            delegate: Rectangle {
                                id: nav
                                required property string modelData
                                required property int index
                                width: 26
                                height: 22
                                radius: 6
                                color: nma.containsMouse ? Theme.ctrl : "transparent"
                                Text { anchors.centerIn: parent; text: nav.modelData; color: Theme.text; font.pixelSize: 16 }
                                MouseArea {
                                    id: nma
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    onClicked: {
                                        const d = new Date(p.viewYear, p.viewMonth + (nav.index === 0 ? -1 : 1), 1);
                                        p.viewYear = d.getFullYear();
                                        p.viewMonth = d.getMonth();
                                    }
                                }
                            }
                        }
                    }
                }
                Grid {
                    id: grid
                    columns: 7
                    width: parent.width
                    readonly property real cell: width / 7
                    readonly property int first: Qt.locale().firstDayOfWeek % 7  // 0 = Sunday
                    // The day the grid starts on: back to the first day of the week on or before the 1st.
                    readonly property date start: {
                        const f = new Date(p.viewYear, p.viewMonth, 1);
                        const back = (f.getDay() - first + 7) % 7;
                        return new Date(p.viewYear, p.viewMonth, 1 - back);
                    }
                    Repeater {
                        model: 7
                        delegate: Text {
                            required property int index
                            width: grid.cell
                            height: 18
                            horizontalAlignment: Text.AlignHCenter
                            text: Qt.locale().dayName((grid.first + index) % 7, Locale.NarrowFormat)
                            color: Theme.text3
                            font.pixelSize: 11
                        }
                    }
                    Repeater {
                        model: 42
                        delegate: Rectangle {
                            id: day
                            required property int index
                            readonly property date d: new Date(grid.start.getFullYear(), grid.start.getMonth(), grid.start.getDate() + index)
                            readonly property bool inMonth: d.getMonth() === p.viewMonth
                            readonly property bool chosen: d.getFullYear() === p.when.getFullYear() && d.getMonth() === p.when.getMonth() && d.getDate() === p.when.getDate()
                            readonly property bool before: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59).getTime() < Date.now()
                            width: grid.cell
                            height: 28
                            radius: 14
                            color: chosen ? Theme.accent : (dma.containsMouse && !before ? Theme.ctrl : "transparent")
                            Text {
                                anchors.centerIn: parent
                                text: day.d.getDate()
                                font.pixelSize: 12
                                color: day.chosen ? "white" : day.before ? Theme.text3 : day.inMonth ? Theme.text : Theme.text2
                                opacity: day.before ? 0.5 : 1
                            }
                            MouseArea {
                                id: dma
                                anchors.fill: parent
                                hoverEnabled: true
                                enabled: !day.before
                                onClicked: p.pickDay(day.d.getFullYear(), day.d.getMonth(), day.d.getDate())
                            }
                        }
                    }
                }

                // Time: hour and minute steppers (the wheel works too), and AM/PM on a 12-hour clock.
                Row {
                    spacing: 8
                    anchors.horizontalCenter: parent.horizontalCenter
                    Stepper {
                        label: p.h24 ? Qt.formatTime(p.when, "HH") : String((p.when.getHours() + 11) % 12 + 1)
                        onStepped: dir => p.addMinutes(dir * 60)
                    }
                    Text { anchors.verticalCenter: parent.verticalCenter; text: ":"; color: Theme.text; font.pixelSize: 18 }
                    Stepper {
                        label: Qt.formatTime(p.when, "mm")
                        onStepped: dir => p.addMinutes(dir * 5)
                    }
                    Row {
                        visible: !p.h24
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 4
                        Repeater {
                            model: ["AM", "PM"]
                            delegate: Rectangle {
                                id: ap
                                required property string modelData
                                required property int index
                                readonly property bool on: (p.when.getHours() >= 12) === (index === 1)
                                width: 38
                                height: 28
                                radius: 8
                                color: on ? Theme.accent : Theme.ctrl
                                Text { anchors.centerIn: parent; text: ap.modelData; color: ap.on ? "white" : Theme.text2; font.pixelSize: 12; font.family: Theme.boldFont }
                                MouseArea {
                                    anchors.fill: parent
                                    onClicked: if (!ap.on) p.setHour((p.when.getHours() + 12) % 24)
                                }
                            }
                        }
                    }
                }

                Text {
                    width: parent.width
                    wrapMode: Text.Wrap
                    color: p.past ? Theme.danger : Theme.text2
                    font.pixelSize: 12
                    text: (p.past ? "Pick a time in the future. " : "Sends " + Hub.sendsLabel(p.when.getTime()) + ". ")
                          + (Hub.hubTimeZone.length && Hub.hubTimeZone !== Hub.localTimeZone()
                             ? "Your time zone is " + Hub.localTimeZone() + (p.differs ? ". In the hub's time zone (" + Hub.hubTimeZone + ") that is " + Hub.inHubZone(p.when.getTime()) + "." : ".")
                             : "Time zone: " + Hub.localTimeZone() + ".")
                }
                Text { visible: p.error.length > 0; width: parent.width; wrapMode: Text.Wrap; text: p.error; color: Theme.danger; font.pixelSize: 12 }

                Row {
                    anchors.right: parent.right
                    spacing: 8
                    Rectangle {
                        width: cancelText.implicitWidth + 28
                        height: 30
                        radius: 15
                        color: Theme.ctrl
                        Text { id: cancelText; anchors.centerIn: parent; text: "Cancel"; color: Theme.text; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; onClicked: p.close() }
                    }
                    Rectangle {
                        readonly property bool ok: !p.busy && !p.past && (p.editable ? input.text.trim().length > 0 : p.text.trim().length > 0)
                        width: okText.implicitWidth + 28
                        height: 30
                        radius: 15
                        color: Theme.accent
                        opacity: ok ? 1 : 0.4
                        Text { id: okText; anchors.centerIn: parent; text: p.busy ? "Saving…" : p.okLabel; color: "white"; font.pixelSize: 13; font.family: Theme.boldFont; font.weight: Font.DemiBold }
                        MouseArea { anchors.fill: parent; enabled: parent.ok; onClicked: p.submit() }
                    }
                }
            }
        }
    }

    // A small number box with up and down arrows.
    component Stepper: Rectangle {
        id: st
        property string label
        signal stepped(int dir)
        width: 56
        height: 56
        radius: 10
        color: Theme.ctrl
        Text { anchors.centerIn: parent; text: st.label; color: Theme.text; font.pixelSize: 22; font.family: Theme.boldFont }
        Text { x: (parent.width - width) / 2; y: 2; text: "▲"; color: Theme.text3; font.pixelSize: 9 }
        Text { x: (parent.width - width) / 2; y: parent.height - height - 2; text: "▼"; color: Theme.text3; font.pixelSize: 9 }
        MouseArea {
            anchors.fill: parent
            onClicked: mouse => st.stepped(mouse.y < st.height / 2 ? 1 : -1)
            onWheel: wheel => { st.stepped(wheel.angleDelta.y > 0 ? 1 : -1); wheel.accepted = true; }
        }
    }
}
