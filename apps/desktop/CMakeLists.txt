cmake_minimum_required(VERSION 3.21)
project(message-hub-desktop VERSION 1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Qt6 6.5 REQUIRED COMPONENTS Quick Network WebSockets DBus ShaderTools)
qt_standard_project_setup(REQUIRES 6.5)

qt_add_executable(message-hub
  src/main.cpp
  src/app.h
  src/hub.h src/hub.cpp
  src/theme.h src/theme.cpp
  src/listmodel.h src/listmodel.cpp
)

# The app icon (shown on the sign-in screen) comes from the web app's icons.
set_source_files_properties(../web/public/icons/icon-192.png PROPERTIES QT_RESOURCE_ALIAS icon.png)

# QML is compiled to C++ at build time (qmlsc), so the window starts without parsing anything.
qt_add_qml_module(message-hub
  URI MessageHub
  VERSION 1.0
  QML_FILES
    qml/Main.qml
    qml/Login.qml
    qml/Sidebar.qml
    qml/ThreadRow.qml
    qml/ThreadView.qml
    qml/MessageRow.qml
    qml/Composer.qml
    qml/Avatar.qml
    qml/TrafficLights.qml
    qml/SearchField.qml
    qml/Field.qml
    qml/Glyph.qml
    qml/RoundedImage.qml
    qml/Menu.qml
  RESOURCES
    ../web/public/icons/icon-192.png
)

qt_add_shaders(message-hub "shaders"
  PREFIX "/"
  FILES shaders/roundedimage.frag
)

target_include_directories(message-hub PRIVATE src)
target_link_libraries(message-hub PRIVATE Qt6::Quick Qt6::Network Qt6::WebSockets Qt6::DBus)

include(GNUInstallDirs)
# The launcher entry points at the installed binary, so it works even when ~/.local/bin isn't on the session's PATH.
configure_file(message-hub.desktop.in message-hub.desktop @ONLY)
install(TARGETS message-hub RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/message-hub.desktop DESTINATION ${CMAKE_INSTALL_DATADIR}/applications)
install(FILES ../web/public/icons/icon-512.png DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/512x512/apps RENAME message-hub.png)
install(FILES ../web/public/icons/icon-192.png DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/192x192/apps RENAME message-hub.png)
