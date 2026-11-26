pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

Window {
    id: win
    width: 1000
    height: 700
    minimumWidth: 660
    minimumHeight: 440
    visible: true
    title: Hub.unreadTotal > 0 ? "Messages (" + Hub.unreadTotal + ")" : "Messages"
    color: "transparent"
    flags: Qt.Window | Qt.FramelessWindowHint

    onActiveChanged: Hub.windowActive = active
    Component.onCompleted: Hub.windowActive = active
    // Closing frees the window and everything in it; the app keeps running small for notifications.
    onClosing: close => { close.accepted = false; App.closeWindow(); }

    Shortcut { sequence: "Ctrl+F"; onActivated: sidebar.focusSearch() }
    Shortcut { sequence: "Ctrl+K"; onActivated: sidebar.focusSearch() }
    Shortcut { sequence: "Ctrl+W"; onActivated: win.close() }
    Shortcut { sequence: "Ctrl+Q"; onActivated: App.quit() }
    Shortcut { sequence: "Ctrl+R"; onActivated: Hub.refresh() }
    Shortcut { sequence: "Alt+Down"; onActivated: sidebar.step(1) }
    Shortcut { sequence: "Alt+Up"; onActivated: sidebar.step(-1) }
    Shortcut { sequence: "Ctrl+Tab"; onActivated: sidebar.step(1) }
    Shortcut { sequence: "Ctrl+Shift+Tab"; onActivated: sidebar.step(-1) }

    Rectangle {
        id: frame
        anchors.fill: parent
        radius: 12
        // With glass the sidebar and the conversation pane tint the compositor's glass each in their own strength.
        color: Theme.glass ? "transparent" : Theme.bg
        border.width: 1
        border.color: Theme.rim
        clip: true

        Sidebar {
            id: sidebar
            objectName: "sidebar"
            window: win
            menu: popup
            width: Math.round(Math.min(340, Math.max(260, win.width * 0.3)))
            height: parent.height
            visible: Hub.signedIn
            onOpened: view.focusComposer()
        }
        Rectangle {
            x: sidebar.width
            width: 1
            height: parent.height
            color: Theme.sep
            visible: Hub.signedIn
        }
        ThreadView {
            id: view
            x: sidebar.width + 1
            width: parent.width - x - 1
            height: parent.height - 1
            window: win
            menu: popup
            visible: Hub.signedIn
        }
        Login {
            anchors.fill: parent
            window: win
            visible: !Hub.signedIn
        }

        Rectangle {
            id: toast
            anchors.horizontalCenter: view.horizontalCenter
            y: 62
            width: Math.min(toastText.implicitWidth + 28, 420)
            height: toastText.height + 14
            radius: height / 2
            color: Theme.danger
            opacity: Hub.error && Hub.signedIn ? 1 : 0
            visible: opacity > 0
            Behavior on opacity { NumberAnimation { duration: 160 } }
            Text {
                id: toastText
                anchors.centerIn: parent
                width: Math.min(implicitWidth, 392)
                text: Hub.error
                color: "white"
                font.pixelSize: 12
                wrapMode: Text.Wrap
                horizontalAlignment: Text.AlignHCenter
            }
            Timer {
                running: toast.visible
                interval: 4500
                onTriggered: Hub.clearError()
            }
            MouseArea { anchors.fill: parent; onClicked: Hub.clearError() }
        }

        Menu { id: popup }

        // Resize edges (the window has no frame of its own).
        MouseArea { x: parent.width - 10; y: parent.height - 10; width: 10; height: 10; z: 100; cursorShape: Qt.SizeFDiagCursor; onPressed: win.startSystemResize(Qt.BottomEdge | Qt.RightEdge) }
        MouseArea { x: parent.width - 5; y: 12; width: 5; height: parent.height - 24; z: 100; cursorShape: Qt.SizeHorCursor; onPressed: win.startSystemResize(Qt.RightEdge) }
        MouseArea { x: 0; y: 12; width: 5; height: parent.height - 24; z: 100; cursorShape: Qt.SizeHorCursor; onPressed: win.startSystemResize(Qt.LeftEdge) }
        MouseArea { x: 12; y: parent.height - 5; width: parent.width - 24; height: 5; z: 100; cursorShape: Qt.SizeVerCursor; onPressed: win.startSystemResize(Qt.BottomEdge) }
    }
}
