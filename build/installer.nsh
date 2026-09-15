; DSH Desktop NSIS 定制钩子（electron-builder include）
!macro customInit
  ; 升级/卸载后重装：electron-builder 的 InstallLocation 随卸载项被删，
  ; 这里从 HKLM 备份键恢复上次安装目录，向导沿用上次位置
  ReadRegStr $INSTDIR HKLM "Software\DSH Desktop" "InstallPath"
!macroend

!macro customInstall
  ; 备份真实安装路径，卸载后重装仍能找到
  WriteRegStr HKLM "Software\DSH Desktop" "InstallPath" "$INSTDIR"
  ; 给 ARP 项补写 InstallLocation，让“设置→应用”显示真实路径
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{${UNINSTALL_APP_KEY}}" "InstallLocation" "$INSTDIR"
!macroend

!macro customUnInstall
  ; 应用与 dsh 子进程是同一个 exe 映像名，不先结束会文件占用、卸载残留
  nsExec::Exec 'taskkill /F /IM "DSH Desktop.exe" /T'
  Sleep 500
!macroend

!macro customUnPageRegister
!macroend

; 卸载完成段之后询问是否删除用户数据（静默卸载等价“否”，不弹框不卡自动化）
!macro customRemoveFiles
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除用户数据（profile、插件、会话与日志）？$\n选择“否”将保留 %APPDATA%\dsh-desktop，重装后可继续使用。" /SD IDNO IDNO keep_data
    RMDir /r "$APPDATA\dsh-desktop"
    RMDir /r "$LOCALAPPDATA\DSH Desktop"
  keep_data:
    DeleteRegKey HKLM "Software\DSH Desktop"
!macroend
