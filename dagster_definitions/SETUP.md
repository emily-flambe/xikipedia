# Xikipedia Dagster Setup

## 1. Install Dependencies

```bash
wsl -d Ubuntu -e bash -c "source /opt/dagster/venv/bin/activate && pip install requests"
```

## 2. Add Code Location to workspace.yaml

Edit `/opt/dagster/dagster_home/workspace.yaml` in WSL2:

```bash
wsl -d Ubuntu -e sudo nano /opt/dagster/dagster_home/workspace.yaml
```

Add this entry:

```yaml
  - python_file:
      relative_path: /mnt/c/Users/emily/Documents/GitHub/xikipedia/dagster_definitions/definitions.py
      location_name: xikipedia
```

## 3. Set Cloudflare API Token

The pipeline needs `CLOUDFLARE_API_TOKEN` to upload to R2.

Edit **both** service files:

```bash
wsl -d Ubuntu -e sudo nano /etc/systemd/system/dagster-webserver.service
wsl -d Ubuntu -e sudo nano /etc/systemd/system/dagster-daemon.service
```

Add under `[Service]` in both:

```ini
Environment=CLOUDFLARE_API_TOKEN=your_token_here
```

## 4. Reload and Restart

```bash
wsl -d Ubuntu -e bash -c "sudo systemctl daemon-reload && sudo systemctl restart dagster-webserver dagster-daemon"
```

## 5. Verify

Open http://pceus:3000 and check:
- Code location "xikipedia" appears
- Assets: `raw_wikipedia_data`, `processed_wikipedia_data`, `r2_wikipedia_data`
- Schedule: `monthly_data_update_schedule` (runs 1st of month at 6am)

## Usage

### Run Manually
In Dagster UI → Jobs → `xikipedia_update_job` → Launch Run

### Check Schedule
Dagster UI → Schedules → `monthly_data_update_schedule`

The schedule is enabled by default and will run at 6am on the 1st of each month.

## Pipeline Flow

```
raw_wikipedia_data      Download from xikipedia.org (~215MB)
        ↓
processed_wikipedia_data    Validate & transform
        ↓
r2_wikipedia_data          Upload to Cloudflare R2
```

Each step is tracked with metadata (article counts, file sizes, timestamps).
