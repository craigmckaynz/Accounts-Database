Option Compare Database
Option Explicit
Function IsLoaded(frmName)

   '  Determines if a form is loaded.
   
   Const conFormDesign = 0
   Dim intX As Integer
   
   IsLoaded = False
   For intX = 0 To Forms.Count - 1
      If Forms(intX).FormName = frmName Then
         If Forms(intX).CurrentView <> conFormDesign Then
            IsLoaded = True
            Exit Function
         End If
      End If
   Next
   
End Function