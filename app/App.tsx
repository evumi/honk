import { mount, View } from "nsh";
import { NavStack } from "nsh/base";
import { BotCreated } from "./src/pages/BotCreated";
import { BotSettings } from "./src/pages/BotSettings";
import { ChatPage } from "./src/pages/Chat";
import { GatewayPage } from "./src/pages/Gateway";
import { Home } from "./src/pages/Home";
import { NewBot } from "./src/pages/NewBot";
import { InAppBanner } from "./src/InAppBanner";
import { incoming } from "./src/inapp";
import { on } from "./src/host";
import { nav, start } from "./src/store";
import { palette } from "./src/theme";

function App() {
  start();
  on("honk.incoming", (payload) => {
    const d = payload as { botId?: unknown; messageId?: unknown } | null;
    if (d?.botId != null && typeof d.messageId === "number") void incoming(String(d.botId), d.messageId);
  });
  return (
    <View style={{ flex: 1, backgroundColor: palette().bg }}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => {
          switch (route.name) {
            case "home":
              return <Home />;
            case "chat":
              return <ChatPage botId={route.botId} />;
            case "newBot":
              return <NewBot botId={route.botId} />;
            case "botCreated":
              return <BotCreated botId={route.botId} token={route.token} botName={route.botName} avatar={route.avatar} />;
            case "botSettings":
              return <BotSettings botId={route.botId} />;
            case "gateway":
              return <GatewayPage />;
          }
        }}
      </NavStack>
      <InAppBanner />
    </View>
  );
}

mount(App);
