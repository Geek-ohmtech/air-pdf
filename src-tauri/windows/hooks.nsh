; Air PDF 설치 프로그램 추가 동작
; - 탐색기 오른쪽 단추 메뉴: PDF(열기·합치기·나누기·이미지로), 그림 파일(PDF로 만들기)
; - Windows "기본 앱" 설정에 Air PDF가 PDF 프로그램으로 나오도록 등록
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
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
