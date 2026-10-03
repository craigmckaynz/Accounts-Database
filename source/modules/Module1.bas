'this will allow you to browse for folder starting at your desktop.

Public BROWSED_FOLDER

Public Type BROWSEINFO
  hwndOwner As Long
  pidlRoot As Long
  pszDisplayName As String
  pszTitle As String
  ulFlags As Long
  lpfn As Long
  lParam As Long
  iImage As Long
End Type

Const MAX_PATH As Long = 260
Const dhcErrorExtendedError = 1208&
Const dhcNoError = 0&

'specify root dir for browse for folder by constants
'you can also specify values by constants for searhcable folders and options.
Const dhcCSIdlDesktop = &H0
Const dhcCSIdlPrograms = &H2
Const dhcCSIdlControlPanel = &H3
Const dhcCSIdlInstalledPrinters = &H4
Const dhcCSIdlPersonal = &H5
Const dhcCSIdlFavorites = &H6
Const dhcCSIdlStartupPmGroup = &H7
Const dhcCSIdlRecentDocDir = &H8
Const dhcCSIdlSendToItemsDir = &H9
Const dhcCSIdlRecycleBin = &HA
Const dhcCSIdlStartMenu = &HB
Const dhcCSIdlDesktopDirectory = &H10
Const dhcCSIdlMyComputer = &H11
Const dhcCSIdlNetworkNeighborhood = &H12
Const dhcCSIdlNetHoodFileSystemDir = &H13
Const dhcCSIdlFonts = &H14
Const dhcCSIdlTemplates = &H15


'constants for limiting choices for BrowseForFolder Dialog

Const dhcBifReturnAll = &H0
Const dhcBifReturnOnlyFileSystemDirs = &H1
Const dhcBifDontGoBelowDomain = &H2
Const dhcBifIncludeStatusText = &H4
Const dhcBifSystemAncestors = &H8
Const dhcBifBrowseForComputer = &H1000
Const dhcBifBrowseForPrinter = &H2000


'... you can get a lot more of these values from your integrated API viewer for constant specifcation or go to AllPai.net and see their samples.

Public Declare Function SHBrowseForFolder Lib "shell32.dll" (ByRef lpbi As BROWSEINFO) As Long

'corrected
Public Declare Function SHGetSpecialFolderLocation Lib "shell32.dll" _
(ByVal hwndOwner As Long, ByVal nFolder As Long, ByRef pidl As Long) As Long



Public Declare Function SHGetPathFromIDList Lib "shell32" (ByVal pidList As Long, ByVal lpBuffer As String) As Long

Public Function BrowseForFolder(ByVal lngCSIDL As Long, _
  ByVal lngBiFlags As Long, _
  strFolder As String, _
  Optional ByVal hwnd As Long = 0, _
  Optional pszTitle As String = "Select Folder") As Long


Dim usrBrws As BROWSEINFO
Dim lngReturn As Long
Dim lngIDL As Long

If SHGetSpecialFolderLocation(hwnd, lngCSIDL, lngIDL) = 0 Then

  'set up the browse structure here
  With usrBrws
      .hwndOwner = hwnd
      .pidlRoot = lngIDL
      .pszDisplayName = String$(MAX_PATH, vbNullChar)
      .pszTitle = pszTitle
      .ulFlags = lngBiFlags
  End With

  'open the dialog
  lngIDL = SHBrowseForFolder(usrBrws)
  
  'if successful
  If lngIDL = 0 Then
      strFolder = ""
  Else
      strFolder = String$(MAX_PATH, vbNullChar)
  End If
    
      'resolve the long value form the lngIDL to a real path
      If SHGetPathFromIDList(lngIDL, strFolder) Then
          strFolder = Left(strFolder, InStr(1, strFolder, vbNullChar) - 1)
          If InStr((Len(strFolder)), strFolder, "\") Then
             strFolder = strFolder
          Else
             strFolder = strFolder & "\"
             BROWSED_FOLDER = strFolder
          End If
          
      lngReturn = dhcNoError 'to show there is no error.
      Else
          'nothing real is available.
          'return a virtual selection
          strFolder = Left(usrBrws.pszDisplayName, InStr(1, usrBrws.pszDisplayName, vbNullChar))
      lngReturn = dhcNoError 'to show there is no error.
      End If
Else
  lngReturn = dhcErrorExtendedError 'something went wrong
End If


BrowseForFolder = lngReturn

End Function


Function GetBrowse() As String
Dim strPath As String
   'now fill the strPath with the choice by user
Call BrowseForFolder(dhcCSIdlDesktop, dhcBifReturnOnlyFileSystemDirs, _
strPath, pszTitle:="Select a folder:")
GetBrowse = BROWSED_FOLDER
End Function