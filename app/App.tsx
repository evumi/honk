import { mount, View } from "nsh";
import { NavStack } from "nsh/base";
import { AddDevicePage } from "./src/pages/AddDevice";
import { BotCreated } from "./src/pages/BotCreated";
import { BotSettings } from "./src/pages/BotSettings";
import { ChatPage } from "./src/pages/Chat";
import { GatewayPage } from "./src/pages/Gateway";
import { Home } from "./src/pages/Home";
import { NewBot } from "./src/pages/NewBot";
import { PairPage } from "./src/pages/Pair";
import { InAppBanner } from "./src/InAppBanner";
import { incoming } from "./src/inapp";
import { listenIncoming, on } from "./src/host";
import { nav, start } from "./src/store";
import { palette } from "./src/theme";

/** The widest the pages get, in points. */
const MAX_WIDTH = 600;

function App() {
  start();
  on("honk.incoming", (payload) => {
    const d = payload as { botId?: unknown; messageId?: unknown } | null;
    if (d?.botId != null && typeof d.messageId === "number") void incoming(String(d.botId), d.messageId);
  });
  // Only now may the host hold back system banners in favour of ours.
  void listenIncoming();
  return (
    // iPad and other wide windows: the pages stay one phone-sized column, centred (the sides show the page background).
    <View style={{ flex: 1, flexDirection: "row", justifyContent: "center", backgroundColor: palette().groupedBg }}>
    <View style={{ flex: 1, maxWidth: MAX_WIDTH, backgroundColor: palette().bg }}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => {
          switch (route.name) {
            case "home":
              return <Home />;
            case "chat":
              return <ChatPage botId={route.botId} messageId={route.messageId} />;
            case "newBot":
              return <NewBot botId={route.botId} />;
            case "botCreated":
              return <BotCreated botId={route.botId} token={route.token} botName={route.botName} avatar={route.avatar} />;
            case "botSettings":
              return <BotSettings botId={route.botId} />;
            case "gateway":
              return <GatewayPage />;
            case "addDevice":
              return <AddDevicePage />;
            case "pair":
              return <PairPage />;
          }
        }}
      </NavStack>
      <InAppBanner />
    </View>
    </View>
  );
}

mount(App);
