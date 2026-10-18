/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-appearance.jsx — custom Settings rows of
   Appearance (window.OMP_SETTINGS_ROWS):
     bgImage   the background image's file name with Choose/Clear buttons;
               picking goes through Rust (`pick_background_image`), which
               copies the chosen file into the app's settings folder, so
               moving the original never breaks the setting
   The row frame and controls are settings/controls.jsx's; the dim/blur
   sliders are plain schema rows in app/settings-schema.js.
   ═════════════════════════════════════════════════════════════════════ */

function _SRA_Background({ row, ctx, query, modified, onReset }) {
  const { SettingsRow: Row, SettingsButton: Button, Icon } = window;
  const { t, setTweak } = ctx;
  const path = t.bgImage ?? null;
  const name = path ? (String(path).split(/[\\/]/).pop() || path) : null;

  const choose = async () => {
    // Bridge swallows errors to null — a cancelled dialog reads the same.
    const picked = await window.OMP_BRIDGE?.pickBackgroundImage();
    if (picked) setTweak("bgImage", picked);
  };

  return (
    <Row stack label={row.label} desc={row.desc} query={query} modified={modified} onReset={onReset}
      aside={(
        <>
          {path && <Button onClick={() => setTweak("bgImage", null)}>Clear</Button>}
          <Button onClick={choose}>
            <Icon name="image" size={11} />{path ? "Change…" : "Choose…"}
          </Button>
        </>
      )}>
      {name && (
        <div className="st-path" title={path}>
          <Icon name="image" size={11} />
          <span className="st-path-text">{name}</span>
        </div>
      )}
    </Row>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  bgImage: _SRA_Background,
});
