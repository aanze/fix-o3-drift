import { definePlugin } from "@decky/api";
import { Content } from "./Content";

export default definePlugin(() => ({
  name: "Odin 3 Stick Fix",
  content: <Content />,
  icon: (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </svg>
  ),
}));
