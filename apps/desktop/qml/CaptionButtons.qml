pragma ComponentBehavior: Bound
import QtQuick
import MessageHub

// Windows 11 caption buttons: minimize, maximize / restore and close, flush in the top-right corner of the window.
Item {
    id: root
    required property Window window
    readonly property bool maximized: window.visibility === Window.Maximized || window.visibility === Window.FullScreen
    // The window's corner is rounded unless it is maximized; the close button follows it.
    property real corner: 0
    width: 138
    height: 32

    readonly property string iconFont: Qt.fontFamilies().indexOf("Segoe Fluent Icons") >= 0 ? "Segoe Fluent Icons" : "Segoe MDL2 Assets"

    // Tells the system where the maximize button is, so Windows 11 can show Snap Layouts over it.
    function reportMaximize() {
        const p = maxButton.mapToItem(null, 0, 0);
        Platform.setMaximizeButton(root.window, Qt.rect(p.x, p.y, maxButton.width, maxButton.height));
    }
    onWidthChanged: Qt.callLater(reportMaximize)
    onXChanged: Qt.callLater(reportMaximize)
    Component.onCompleted: Qt.callLater(reportMaximize)
    Connections {
        target: Platform
        function onMaximizeClicked() { root.toggleMaximize(); }
    }
    function toggleMaximize() { if (maximized) window.showNormal(); else window.showMaximized(); }

    component Caption: Item {
        id: btn
        property string glyph
        property bool close: false
        property bool hot: false
        property bool pressed: false
        signal clicked()
        width: 46
        height: 32

        // Close turns red under the pointer; the others get a faint wash.
        Rectangle {
            anchors.fill: parent
            visible: btn.close && (btn.hot || btn.pressed) && btn.width > 0
            color: btn.pressed ? "#B3C42B1C" : "#C42B1C"
            radius: root.corner
            // Only the top-right corner follows the window's rounding.
            Rectangle { x: 0; width: parent.width - parent.radius; height: parent.height; color: parent.color }
            Rectangle { y: parent.radius; width: parent.width; height: parent.height - parent.radius; color: parent.color }
        }
        Rectangle {
            anchors.fill: parent
            visible: !btn.close
            color: Theme.dark ? "#FFFFFF" : "#000000"
            opacity: btn.pressed ? 0.04 : btn.hot ? 0.07 : 0
        }
        Text {
            anchors.centerIn: parent
            text: btn.glyph
            font.family: root.iconFont
            font.pixelSize: 10

            color: btn.close && (btn.hot || btn.pressed) ? "white" : (root.window.active ? Theme.text : Theme.text3)
        }
    }

    Row {
        Caption {
            glyph: ""
            hot: minMa.containsMouse
            pressed: minMa.pressed
            MouseArea { id: minMa; anchors.fill: parent; hoverEnabled: true; onClicked: root.window.showMinimized() }
        }
        Caption {
            id: maxButton
            glyph: root.maximized ? "" : ""
            hot: maxMa.containsMouse || Platform.maximizeHover
            pressed: maxMa.pressed || Platform.maximizeDown
            onXChanged: Qt.callLater(root.reportMaximize)
            MouseArea { id: maxMa; anchors.fill: parent; hoverEnabled: true; onClicked: root.toggleMaximize() }
        }
        Caption {
            glyph: ""
            close: true
            hot: closeMa.containsMouse
            pressed: closeMa.pressed
            MouseArea { id: closeMa; anchors.fill: parent; hoverEnabled: true; onClicked: root.window.close() }
        }
    }
}
