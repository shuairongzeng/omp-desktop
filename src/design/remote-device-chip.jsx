/* design/remote-device-chip.jsx — phone topbar chip naming the desktop
   this phone controls (multi-desktop remote control). Tapping opens the
   device hub (app/remote-hub.js) to switch between paired desktops or
   add a new one. Renders only under the remote shim: the desktop webview
   has no OMP_REMOTE_HUB, and chrome.jsx guards on window.RemoteDeviceChip
   being a live component that returns null there anyway. */
function RemoteDeviceChip() {
  const hub = window.OMP_REMOTE_HUB;
  const [name, setName] = React.useState("桌面");
  React.useEffect(() => {
    if (!hub) return undefined;
    const sync = () => {
      const D = window.OMP_REMOTE_DEVICES;
      const cur = hub.current();
      setName(cur && D ? D.displayName(cur) : "桌面");
    };
    sync();
    // The hub dispatches on every relay `device` frame (name arrived or
    // changed); the chip's label follows.
    window.addEventListener("omp:remote-device", sync);
    return () => window.removeEventListener("omp:remote-device", sync);
  }, [hub]);
  if (!hub) return null;
  return (
    <button className="mobile-topbar-device" aria-label="切换桌面设备"
      onClick={() => hub.open()}>
      <span className="mtd-name">{name}</span>
    </button>
  );
}
window.RemoteDeviceChip = RemoteDeviceChip;
