// Synthetic CPU workload: text, static SVG caching and continuously animated geometry.
use fframes::{AudioMap, Color, Duration, EncoderOptions, FFramesContext, Frame, RenderOptions, StaticMediaProvider, Svgr, Video, cli};
use fframes_benchmark::FframesBenchmarkMedia;

struct Benchmark;

impl Video for Benchmark {
    const FPS: usize = 30;
    const WIDTH: usize = 1920;
    const HEIGHT: usize = 1080;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> { Duration::Seconds(15.0) }
    fn audio(&self) -> AudioMap<'_> { AudioMap::none() }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let seconds = frame.seconds();
        let progress = seconds / 15.0;
        let bar_a = 150.0 + 170.0 * (seconds * 0.8).sin().abs();
        let bar_b = 160.0 + 220.0 * (seconds * 0.6 + 1.0).sin().abs();
        let bar_c = 180.0 + 260.0 * (seconds * 0.5 + 2.0).sin().abs();
        let orbit_x = 1440.0 + 130.0 * (seconds * 0.7).cos();
        let orbit_y = 570.0 + 130.0 * (seconds * 0.7).sin();
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
                <rect width="1920" height="1080" fill="#101827" />
                <text x="120" y="165" font-family="DM Sans" font-size="38" font-weight="500" fill="#6ee7b7">"FFRAMES / CPU RENDER"</text>
                <text x="120" y="290" font-family="DM Sans" font-size="96" font-weight="500" fill="#f1f5f9">"Motion, made with code."</text>
                <text x="120" y="360" font-family="DM Sans" font-size="38" font-weight="500" fill="#94a3b8">"1920 x 1080   /   30 fps   /   15 seconds"</text>
                <rect x="120" y="430" width="1000" height="430" rx="24" fill="#1e293b" />
                <line x1="185" y1="800" x2="1050" y2="800" stroke="#64748b" stroke-width="3" />
                <rect x="230" y={800.0 - bar_a} width="180" height={bar_a} rx="12" fill="#6ee7b7" />
                <rect x="530" y={800.0 - bar_b} width="180" height={bar_b} rx="12" fill="#38bdf8" />
                <rect x="830" y={800.0 - bar_c} width="180" height={bar_c} rx="12" fill="#a78bfa" />
                <circle cx="1440" cy="570" r="130" fill="none" stroke="#334155" stroke-width="3" />
                <circle cx="1440" cy="570" r="65" fill="#38bdf8" />
                <circle cx={orbit_x} cy={orbit_y} r="24" fill="#6ee7b7" />
                <text x="1300" y="810" font-family="DM Sans" font-size="54" font-weight="500" fill="#f1f5f9">{format!("{seconds:04.1} / 15.0 s")}</text>
                <rect x="120" y="950" width="1680" height="12" rx="6" fill="#334155" />
                <rect x="120" y="950" width={12.0 + 1668.0 * progress} height="12" rx="6" fill="#6ee7b7" />
            </svg>
        )
    }
}

fn main() -> std::process::ExitCode {
    let media = FframesBenchmarkMedia::prepare().expect("benchmark's embedded starter font");
    cli::new(&Benchmark, RenderOptions {
        media: Some(&media),
        video_encoder_options: EncoderOptions {
            preferred_encoder: Some("libx264"),
            codec_params: Some(&[("crf", "20"), ("preset", "medium"), ("tune", "animation")]),
            ..Default::default()
        },
        ..Default::default()
    }).run()
}
