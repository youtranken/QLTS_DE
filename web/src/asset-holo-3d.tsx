/* Hologram đội thiết bị — port từ PMH-ID portal-fe (AssetHolo3D). Laptop wireframe
   CSS-3D xoay giữa bệ hologram, 3 laptop mini bay quanh vành nét đứt. Thuần
   transform/opacity — nhẹ GPU, không lib/bitmap/WebGL. Dùng làm nền màn đăng nhập. */
export function AssetHolo3D({ className }: { className?: string }) {
  return (
    <div className={`holo3${className ? ' ' + className : ''}`} aria-hidden>
      <div className="holo3-stage">
        <div className="holo3-tilt">
          <div className="holo3-ring" />
          <div className="holo3-ring holo3-ring--dash" />
          {/* laptop chính — xoay quanh trục đứng */}
          <div className="holo3-spin">
            <div className="holo3-base" />
            <div className="holo3-lid" />
          </div>
          {/* đội thiết bị: 3 laptop mini bay quanh (quay ngược chiều) */}
          <div className="holo3-orbit">
            <div className="holo3-sat holo3-sat1"><i className="holo3-sbase" /><i className="holo3-slid" /></div>
            <div className="holo3-sat holo3-sat2"><i className="holo3-sbase" /><i className="holo3-slid" /></div>
            <div className="holo3-sat holo3-sat3"><i className="holo3-sbase" /><i className="holo3-slid" /></div>
          </div>
          <div className="holo3-glow" />
          <div className="holo3-scan" />
        </div>
      </div>

      {/* hạt dữ liệu trôi */}
      <div className="holo3-bit" style={{ left: '22%', top: '34%' }} />
      <div className="holo3-bit" style={{ left: '14%', top: '62%', animationDelay: '1.6s' }} />
      <div className="holo3-bit" style={{ left: '78%', top: '30%', animationDelay: '3s' }} />
      <div className="holo3-bit" style={{ left: '84%', top: '58%', animationDelay: '4.2s' }} />
    </div>
  );
}
