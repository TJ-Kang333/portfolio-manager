Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$path) {
    $bmp = [System.Drawing.Bitmap]::new($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    # background: app's --text color (#1A1A18), rounded square
    $bg = [System.Drawing.Color]::FromArgb(255, 26, 26, 24)
    $brush = [System.Drawing.SolidBrush]::new($bg)
    $radius = [int]($size * 0.18)
    $gp = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $d = $radius * 2
    $gp.AddArc(0, 0, $d, $d, 180, 90)
    $gp.AddArc($size-$d, 0, $d, $d, 270, 90)
    $gp.AddArc($size-$d, $size-$d, $d, $d, 0, 90)
    $gp.AddArc(0, $size-$d, $d, $d, 90, 90)
    $gp.CloseFigure()
    $g.FillPath($brush, $gp)

    # letter: white "P"
    $fontSize = [single]($size * 0.52)
    $font = [System.Drawing.Font]::new("Arial", $fontSize, [System.Drawing.FontStyle]::Bold)
    $white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
    $textBrush = [System.Drawing.SolidBrush]::new($white)
    $fmt = [System.Drawing.StringFormat]::new()
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = [System.Drawing.RectangleF]::new(0.0, 0.0, [single]$size, [single]$size)
    $g.DrawString("P", $font, $textBrush, $rect, $fmt)

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

$dir = "C:\Users\kangg\portfolio-manager\icons"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
New-Icon 192 "$dir\icon-192.png"
New-Icon 512 "$dir\icon-512.png"
"done"
