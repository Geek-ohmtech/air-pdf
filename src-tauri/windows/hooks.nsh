; Air PDF 설치 프로그램 추가 동작
; - 탐색기 오른쪽 단추 메뉴: PDF(열기·합치기·나누기·이미지로), 그림 파일(PDF로 만들기)
; - Windows "기본 앱" 설정에 Air PDF가 PDF 프로그램으로 나오도록 등록
; - 탐색기 미리보기 창·미리보기 그림 (shell\airpdf_shell_판.dll)
; - 'Air PDF' 프린터를 쓰고 있으면 인쇄 감시를 새 판으로 다시 켠다
; 여러 파일을 고르고 누르면 파일마다 실행되지만, 이미 켜진 Air PDF가 받아 모아서 한 번에 처리한다.

!macro AIRPDF_VERB BASE KEY LABEL ARGS
  WriteRegStr SHCTX "${BASE}\shell\${KEY}" "MUIVerb" "${LABEL}"
  WriteRegStr SHCTX "${BASE}\shell\${KEY}" "MultiSelectModel" "Player"
  WriteRegStr SHCTX "${BASE}\shell\${KEY}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" ${ARGS} "%1"'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; PDF 파일 메뉴 (하위 메뉴로 묶음)
  StrCpy $0 "Software\Classes\SystemFileAssociations\.pdf\shell\AirPDF"
  WriteRegStr SHCTX "$0" "MUIVerb" "Air PDF"
  WriteRegStr SHCTX "$0" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "$0" "SubCommands" ""
  !insertmacro AIRPDF_VERB "$0" "1open" "Air PDF로 열기" ""
  !insertmacro AIRPDF_VERB "$0" "2merge" "PDF 합치기" "--merge"
  !insertmacro AIRPDF_VERB "$0" "3split" "PDF 나누기 (분할)" "--split"
  !insertmacro AIRPDF_VERB "$0" "4images" "PDF → 이미지" "--to-images"
  !insertmacro AIRPDF_VERB "$0" "5batch" "한꺼번에 처리 (보정·OCR·용량)" "--batch"

  ; 그림 파일 메뉴
  StrCpy $0 "Software\Classes\SystemFileAssociations\image\shell\AirPDF.ToPdf"
  WriteRegStr SHCTX "$0" "MUIVerb" "Air PDF: 이미지 → PDF"
  WriteRegStr SHCTX "$0" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "$0" "MultiSelectModel" "Player"
  WriteRegStr SHCTX "$0\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --to-pdf "%1"'

  ; 기본 앱 설정에 나오도록
  WriteRegStr SHCTX "Software\Classes\AirPDF.Document" "" "PDF 문서"
  WriteRegStr SHCTX "Software\Classes\AirPDF.Document\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\AirPDF.Document\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "AirPDF.Document" ""
  WriteRegStr SHCTX "Software\AirPDF\Capabilities" "ApplicationName" "Air PDF"
  WriteRegStr SHCTX "Software\AirPDF\Capabilities" "ApplicationDescription" "문서는 가볍게, 작업은 자유롭게"
  WriteRegStr SHCTX "Software\AirPDF\Capabilities\FileAssociations" ".pdf" "AirPDF.Document"
  WriteRegStr SHCTX "Software\RegisteredApplications" "AirPDF" "Software\AirPDF\Capabilities"

  ; 탐색기 미리보기: 탐색기가 쓰고 있는 DLL은 덮어쓸 수 없으므로 판마다 새 이름으로 둔다
  CreateDirectory "$INSTDIR\shell"
  CopyFiles /SILENT "$INSTDIR\airpdf_shell.dll.bin" "$INSTDIR\shell\airpdf_shell_${VERSION}.dll"
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --register-shell "$INSTDIR\shell\airpdf_shell_${VERSION}.dll"'
  ; 예전 판 DLL은 지운다 (쓰는 중이면 다음에 다시 켤 때 지워짐)
  FindFirst $1 $2 "$INSTDIR\shell\airpdf_shell_*.dll"
  airpdf_old_loop:
    StrCmp $2 "" airpdf_old_done
    StrCmp $2 "airpdf_shell_${VERSION}.dll" airpdf_old_next
    Delete /REBOOTOK "$INSTDIR\shell\$2"
  airpdf_old_next:
    FindNext $1 $2
    Goto airpdf_old_loop
  airpdf_old_done:
  FindClose $1

  ; 'Air PDF' 프린터를 쓰고 있으면 인쇄 감시를 새 판으로 (옛 감시는 스스로 끝난다)
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AirPDF Print"
  StrCmp $1 "" airpdf_print_done
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AirPDF Print" '"$SYSDIR\rundll32.exe" "$INSTDIR\shell\airpdf_shell_${VERSION}.dll",PrintWatch'
    Exec '"$SYSDIR\rundll32.exe" "$INSTDIR\shell\airpdf_shell_${VERSION}.dll",PrintWatch'
  airpdf_print_done:

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 업데이트 중에는 지우지 않는다 (업데이트는 제거 없이 덮어쓰지만, 혹시 몰라)
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.pdf\shell\AirPDF"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\image\shell\AirPDF.ToPdf"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "AirPDF"
  DeleteRegKey SHCTX "Software\AirPDF"
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "AirPDF.Document"
  DeleteRegKey SHCTX "Software\Classes\AirPDF.Document"
  ${If} $UpdateMode <> 1
    ; 탐색기 미리보기 등록 풀기, 인쇄 감시 끄기
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --unregister-shell'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AirPDF Print"
    ; 'Air PDF' 프린터가 있으면 빼기 (관리자 확인 창이 뜬다)
    ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Control\Print\Printers\Air PDF" "Name"
    StrCmp $1 "" airpdf_noprinter
      ExecShellWait "runas" "powershell.exe" "-NoProfile -WindowStyle Hidden -Command Remove-Printer -Name 'Air PDF'" SW_HIDE
    airpdf_noprinter:
    Delete "$INSTDIR\airpdf_shell.dll.bin"
    RMDir /r /REBOOTOK "$INSTDIR\shell"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
