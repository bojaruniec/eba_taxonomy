# Kolumna `order`
w orginalnych plikach XBRL order nie jest liczbą
całkowitą, w odczytanym pliku przez Jackcess jest
to Longint. 
1. Do sprawdzenia w Windowsie.
2. Jeżeli w Windowsie tak samo, to:
 a. tymczasowe pominięcie kolumny Orders
 b. odczytanie plików XBRL