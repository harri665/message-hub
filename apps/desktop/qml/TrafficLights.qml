pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

// The window buttons, drawn like MacShell's own app windows: close, minimize (greyed out, Hyprland has no
// minimize) and zoom. Symbols show while the pointer is over the group.
Item {
    id: root
    required property Window window
    width: 58
    height: 14

    Row {
        spacing: 8
        scale: 0.93
        transformOrigin: Item.TopLeft
        Repeater {
            model: [{ c: "#FF5F57", g: 0, on: true }, { c: "#FEBC2E", g: 1, on: false }, { c: "#28C840", g: 2, on: true }]
            delegate: Rectangle {
                id: light
                required property var modelData
                readonly property bool lit: modelData.on && (root.window.active || hover.containsMouse)
                width: 14
                height: 14
                radius: 7
                color: lit ? modelData.c : Theme.lightOff
                border.width: 1
                border.color: lit ? Qt.darker(modelData.c, Theme.dark ? 1.12 : 1.22) : "transparent"
                Canvas {
                    anchors.fill: parent
                    visible: hover.containsMouse && light.modelData.on
                    onVisibleChanged: if (visible) requestPaint()
                    onPaint: {
                        const ctx = getContext("2d");
                        ctx.clearRect(0, 0, width, height);
                        ctx.strokeStyle = ctx.fillStyle = "rgba(0,0,0,0.58)";
                        ctx.lineCap = "round";
                        ctx.beginPath();
                        if (light.modelData.g === 0) {
                            ctx.lineWidth = 1.1;
                            ctx.moveTo(4.9, 4.9); ctx.lineTo(9.1, 9.1);
                            ctx.moveTo(9.1, 4.9); ctx.lineTo(4.9, 9.1);
                            ctx.stroke();
                        } else {
                            ctx.moveTo(6, 4); ctx.lineTo(10, 4); ctx.lineTo(10, 8); ctx.closePath(); ctx.fill();
                            ctx.beginPath();
                            ctx.moveTo(8, 10); ctx.lineTo(4, 10); ctx.lineTo(4, 6); ctx.closePath(); ctx.fill();
                        }
                    }
                }
            }
        }
    }

    MouseArea {
        id: hover
        anchors.fill: parent
        anchors.margins: -4
        hoverEnabled: true
        onClicked: mouse => {
            if (mouse.x < 26) root.window.close();
            else if (mouse.x < 48) { }
            else if (root.window.visibility === Window.Maximized || root.window.visibility === Window.FullScreen) root.window.showNormal();
            else root.window.showMaximized();
        }
    }
}
